import * as archiver from "archiver";
import { XMLParser } from "fast-xml-parser";
import { glob } from "glob";
import fetch from "node-fetch";
import * as path from "path";
import * as streamBuffers from "stream-buffers";
import { commands, ExtensionContext, InputBoxOptions, window, workspace } from "vscode";
import * as vscode from 'vscode';
import { AsyncItem, AsyncTreeDataProvider } from "./asyncTree";
import { delay, getConfig } from "./utils";
import FormData = require("form-data");


type TransportParam = { name: string; value: string };
type Transport = { uri: string; params: TransportParam[]; fileParams: TransportParam[] };
type Exclude = { pattern: string };
type Assignment = { name: string; excludes: Exclude[]; transport: Transport };
type AssignmentGroup = { name: string; assignments: Assignment[] };
type SubmissionRoot = { excludes: Exclude[]; groups: AssignmentGroup[] };

type AssignmentItem = {
  assignment: Assignment;
  group: AssignmentGroup;
  root: SubmissionRoot;
  provider: UploadDataProvider;
};

const parser = new XMLParser({ ignoreAttributes: false, isArray: (_, __, ___, isAttribute) => !isAttribute });

const parseTransportParam = (value: any): TransportParam => {
  return {
    name: value["@_name"],
    value: value["@_value"],
  };
};

const parseTransport = (value: any): Transport => {
  return {
    uri: value["@_uri"],
    params: value["param"].map(parseTransportParam),
    fileParams: value["file-param"].map(parseTransportParam),
  };
};

const parseExclude = (value: any): Exclude => {
  return { pattern: value["@_pattern"] };
};

const parseAssignment = (value: any): Assignment => {
  return {
    name: value["@_name"],
    excludes: value["exclude"]?.map(parseExclude) ?? [],
    transport: parseTransport(value["transport"][0]),
  };
};

const parseAssignmentGroup = (value: any): AssignmentGroup => {
  return {
    name: value["@_name"],
    assignments: value["assignment"].map(parseAssignment),
  };
};

const parseSubmissionRoot = (value: any): SubmissionRoot => {
  console.log(value);
  return {
    excludes: value["submission-targets"][0]["exclude"].map(parseExclude),
    groups: value["submission-targets"][0]["assignment-group"].map(parseAssignmentGroup),
  };
};

export class UploadDataProvider extends AsyncTreeDataProvider {
  private async fetchSite(url: string): Promise<SubmissionRoot> {
    const resp = await fetch(url);
    const content = await resp.text();
    const xml = parser.parse(content);
    return parseSubmissionRoot(xml);
  }

  async fetchData() {
    const config = workspace.getConfiguration('itsc2214');
    const uploadURL = config.get<string>('uploadURL');
    if (!uploadURL) return;

    const root = await this.fetchSite(uploadURL);

    return root.groups.map(
        (group: AssignmentGroup) =>
          new AsyncItem({
            label: group.name,
            iconId: "project",
            children: group.assignments.map(
              (assignment: Assignment) =>
                new AsyncItem({
                  label: assignment.name,
                  iconId: "package",
                  contextValue: "project",
                  item: {
                    assignment: { ...assignment, excludes: [...root.excludes, ...assignment.excludes] },
                    group,
                    root,
                    provider: this,
                  },
                })
            ),
          })
      );
  }

  beforeLoad() {
    commands.executeCommand("setContext", "web-CAT.targetsErrored", false);
    commands.executeCommand("setContext", "web-CAT.targetsLoaded", false);
  }

  afterLoad() {
    commands.executeCommand("setContext", "web-CAT.targetsErrored", false);
    commands.executeCommand("setContext", "web-CAT.targetsLoaded", true);
  }

  onLoadError(e: Error) {
    super.onLoadError(e);
    commands.executeCommand("setContext", "web-CAT.targetsErrored", true);
  }
}

const PROMPT_ON: { [key: string]: InputBoxOptions } = {
  "${user}": { prompt: "Web-CAT Username" },
  "${pw}": { prompt: "Web-CAT Password", password: true },
};

export const uploadItem = (item: AsyncItem, context: ExtensionContext) => {
    const { assignment: _assignment, group: _group, provider } = <AssignmentItem>item.item;
  
    const action = async () => {
      // Save all unsaved files before submission
      const saved = await workspace.saveAll();
      if (!saved) {
        const proceed = await window.showWarningMessage(
          'Some files could not be saved. Continue with submission?',
          'Yes', 'No'
        );
        if (proceed !== 'Yes') {
          return window.showInformationMessage('Submission canceled.');
        }
      }
      
  
      const groups = await provider.fetchData();
      const group = groups?.find((x) => x.label === _group.name);
      const { assignment } = <AssignmentItem>(group?.children?.find((x: AsyncItem) => x.label === _assignment.name)?.item ?? item);
  
      
  
      const vars: Map<string, string> = new Map();
      const formatVars = (value: string) => {
        for (const [k, v] of vars.entries()) {
          value = value.replace(k, v);
        }
        return value;
      };
  
      const files: { param: TransportParam; dir: string }[] = [];
      const workspaceRoot = workspace.workspaceFolders?.[0]?.uri;

      for (const param of assignment.transport.fileParams) {
        let submissionUri: vscode.Uri | undefined;
        if (workspaceRoot) {
            const submitUri = vscode.Uri.joinPath(workspaceRoot, 'submit');
            const srcUri = vscode.Uri.joinPath(workspaceRoot, 'src');

            try {
                await workspace.fs.stat(submitUri);
                submissionUri = submitUri;
            } catch {
                try {
                    await workspace.fs.stat(srcUri);
                    submissionUri = srcUri;
                } catch {
                    // Neither folder exists
                }
            }
        }

        if (!submissionUri) {
            const dirResult = await window.showOpenDialog({
                title: "Select Submission Folder",
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                defaultUri: workspaceRoot,
                openLabel: `Select Folder (${param.name})`,
            });
    
            if (dirResult) {
                submissionUri = dirResult[0];
            }
        }

        if (!submissionUri) {
            return window.showInformationMessage("Operation canceled.");
        }

        files.push({ param, dir: submissionUri.fsPath });
      }
  
      
  
      const body = new FormData();
  
      for (const param of assignment.transport.params) {
        if (PROMPT_ON.hasOwnProperty(param.value)) {
          let value = vars.get(param.value);
          if (!value) {
            value = await window.showInputBox({
              ...PROMPT_ON[param.value],
              value: context.globalState.get(param.value),
            });
            if (!value) return window.showInformationMessage("Operation canceled.");
          }
          await context.globalState.update(param.value, value);
          vars.set(param.value, value);
        }
  
        body.append(param.name, formatVars(param.value));
      }
  
      
  
      for (const { param, dir } of files) {
        const output = new streamBuffers.WritableStreamBuffer();
        const archive = archiver("zip");
        archive.pipe(output);
  
        const paths = await glob("**/*", {
          cwd: dir,
          ignore: [
            ...assignment.excludes.map((x) => x.pattern),
            "*.gdoc",
            "*.gslides",
            "*.gsheet",
            "*.gdraw",
            "*.gtable",
            "*.gform",
          ],
        });
  
        for (const file of paths) {
          archive.file(path.join(dir, file), { name: file });
        }
  
        archive.on("warning", (err) => {
          window.showWarningMessage(`An warning occurred: ${err?.message}`);
        });
  
        archive.on("error", (err) => {
          window.showErrorMessage(`An error occurred: ${err?.message}`);
        });
  
        await archive.finalize();
        body.append(param.name, output.getContents(), {
          filename: formatVars(param.value),
        });
      }
  
      const resp = await fetch(assignment.transport.uri, {
        method: "POST",
        body,
      });
      const html = await resp.text();
      const match = html.match(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"/);
      const resultsUrl = match ? match[1] : undefined;
      
      if (resultsUrl) {
        const choice = await window.showInformationMessage(
            "WebCAT submission successful.",
            "Open"
        );

        if (choice === "Open") {
            vscode.env.openExternal(vscode.Uri.parse(resultsUrl));
        }
      } else {
        window.showErrorMessage("Could not find submission results URL. Please check the WebCAT website directly.");
      }
    };
  
    try {
      window.withProgress({ location: { viewId: "uploadBrowser" }, title: "Uploading..." }, () =>
        Promise.all([delay(1000), action()])
      );
    } catch (err) {
      if (err instanceof Error) {
        window.showErrorMessage(`An error occurred: ${err.message}`);
      } else {
        window.showErrorMessage(`An error occurred: ${String(err)}`);
      }
      console.error(err);
    }
  };
