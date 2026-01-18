import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Readable } from 'stream';
import * as unzip from 'unzip-stream';
import { XMLParser } from 'fast-xml-parser';
import { copyJarsToDir } from './projectCreator';

type AssignmentItemData = {
    label: string;
    description: string;
    url: string;
    category: string;
};

class AssignmentTreeItem extends vscode.TreeItem {
    children?: AssignmentTreeItem[];
    itemData?: AssignmentItemData;

    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        iconId?: string,
        children?: AssignmentTreeItem[],
        itemData?: AssignmentItemData
    ) {
        super(label, collapsibleState);
        this.children = children;
        this.itemData = itemData;
        if (iconId) {
            this.iconPath = new vscode.ThemeIcon(iconId);
        }
        if (itemData) {
            this.contextValue = 'assignment';
            this.description = itemData.description;
            this.tooltip = itemData.description;
        }
    }
}

export class AssignmentProvider implements vscode.TreeDataProvider<AssignmentTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<AssignmentTreeItem | undefined | null | void> = new vscode.EventEmitter();
    readonly onDidChangeTreeData: vscode.Event<AssignmentTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: AssignmentTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: AssignmentTreeItem): Thenable<AssignmentTreeItem[]> {
        if (element) {
            return Promise.resolve(element.children || []);
        }
        return this.fetchData();
    }

    private async fetchSite(url: string): Promise<{ label: string; packages: AssignmentItemData[] }> {
        const resp = await fetch(url);
        if (!resp.ok) {
            vscode.window.showErrorMessage(`Failed to fetch assignments from ${url}. Check the URL and your internet connection.`);
            return { label: 'Error', packages: [] };
        }

        const content = await resp.text();
        try {
            const parser = new XMLParser({ 
                ignoreAttributes: false, 
                isArray: (_, __, ___, isAttribute) => !isAttribute 
            });
            const result = parser.parse(content);
            const snarfSite = result['snarf_site'][0];
            const siteName = snarfSite['@_name'];
            const packages = snarfSite['package'].map((p: any) => ({
                label: p['@_name'],
                description: p['description'][0],
                url: p['entry'][0]['@_url'],
                category: p['@_category'] || 'Uncategorized',
            }));
            return { label: siteName, packages };
        } catch (error) {
            vscode.window.showErrorMessage('Failed to parse assignment data.');
            return { label: 'Error', packages: [] };
        }
    }

    private async fetchData(): Promise<AssignmentTreeItem[]> {
        const config = vscode.workspace.getConfiguration('itsc2214');
        const downloadURL = config.get<string>('downloadURL');

        if (!downloadURL) {
            vscode.window.showWarningMessage('Assignment download URL is not configured.');
            return [];
        }

        const { label, packages } = await this.fetchSite(downloadURL);

        const categories: { [key: string]: AssignmentItemData[] } = {};
        for (const pkg of packages) {
            if (!categories[pkg.category]) {
                categories[pkg.category] = [];
            }
            categories[pkg.category].push(pkg);
        }

        const categoryItems = Object.keys(categories).sort().map(category => {
            const assignmentItems = categories[category].map(pkg =>
                new AssignmentTreeItem(pkg.label, vscode.TreeItemCollapsibleState.None, undefined, undefined, pkg)
            );
            assignmentItems.sort((a, b) => (a.label! as string).localeCompare(b.label! as string));
            return new AssignmentTreeItem(category, vscode.TreeItemCollapsibleState.Expanded, 'folder', assignmentItems);
        });

        const rootItem = new AssignmentTreeItem(label, vscode.TreeItemCollapsibleState.Expanded, 'project', categoryItems);
        return [rootItem];
    }
}

async function downloadAndUnzip(itemData: AssignmentItemData, context: vscode.ExtensionContext): Promise<vscode.Uri | undefined> {
    const itsc2214Dir = context.globalState.get<string>('itsc2214Dir');
    if (!itsc2214Dir) {
        vscode.window.showErrorMessage('ITSC2214 project directory not set. Please create a project first.');
        return undefined;
    }

    const baseProjectName = itemData.label.replace(/[^a-zA-Z0-9- ]/g, '').replace(/\s+/g, '-');
    let projectUri = vscode.Uri.joinPath(vscode.Uri.file(itsc2214Dir), baseProjectName);

    try {
        await vscode.workspace.fs.stat(projectUri);
        const choice = await vscode.window.showWarningMessage(
            `Project "${baseProjectName}" already exists. Create a new copy?`,
            "Yes",
            "No"
        );

        if (choice === 'Yes') {
            let n = 1;
            let finalProjectName;
            while (true) {
                finalProjectName = `copy_${baseProjectName}_${n}`;
                projectUri = vscode.Uri.joinPath(vscode.Uri.file(itsc2214Dir), finalProjectName);
                try {
                    await vscode.workspace.fs.stat(projectUri);
                    n++;
                } catch {
                    break;
                }
            }
        } else {
            return undefined;
        }
    } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
            console.error('Error checking for project directory:', error);
            vscode.window.showErrorMessage('An error occurred while checking for the project directory.');
            return;
        }
    }

    await vscode.workspace.fs.createDirectory(projectUri);

    const resp = await fetch(itemData.url);
    if (!resp.ok) {
        vscode.window.showErrorMessage(`Failed to download assignment: ${resp.statusText}`);
        return undefined;
    }

    const tempDirUri = vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'itsc2214-unzip-')));

    return new Promise<vscode.Uri | undefined>((resolve, reject) => {
        if (!resp.body) {
            reject(new Error('Response body is empty'));
            return;
        }
        const extractStream = unzip.Extract({ path: tempDirUri.fsPath });
        const nodeStream = Readable.fromWeb(resp.body as import('stream/web').ReadableStream);
        nodeStream.pipe(extractStream);
        extractStream.on('error', reject);
        extractStream.on('finish', async () => {
            try {
                const macosxUri = vscode.Uri.joinPath(tempDirUri, '__MACOSX');
                try {
                    await vscode.workspace.fs.delete(macosxUri, { recursive: true });
                } catch (e) {

                }

                let projectRootUri = tempDirUri;
                const entries = await vscode.workspace.fs.readDirectory(tempDirUri);
                if (entries.length === 1 && entries[0][1] === vscode.FileType.Directory) {
                    projectRootUri = vscode.Uri.joinPath(tempDirUri, entries[0][0]);
                }

                const projectFiles = await vscode.workspace.fs.readDirectory(projectRootUri);
                for (const [fileName] of projectFiles) {
                    const oldPath = vscode.Uri.joinPath(projectRootUri, fileName);
                    const newPath = vscode.Uri.joinPath(projectUri, fileName);
                    await vscode.workspace.fs.rename(oldPath, newPath);
                }

                await vscode.workspace.fs.delete(tempDirUri, { recursive: true });

                // Only copy global JARs if the downloaded project doesn't have any
                const libUri = vscode.Uri.joinPath(projectUri, 'lib');
                let hasJars = false;
                try {
                    const libEntries = await vscode.workspace.fs.readDirectory(libUri);
                    hasJars = libEntries.some(([name, type]) => 
                        type === vscode.FileType.File && name.endsWith('.jar')
                    );
                } catch {
                    // lib folder doesn't exist
                }

                if (!hasJars) {
                    await copyJarsToDir(projectUri, 'lib', context);
                }

                resolve(projectUri);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export async function downloadAssignment(item: AssignmentTreeItem, context: vscode.ExtensionContext) {
    if (!item || !item.itemData) {
        return;
    }
    const itemData = item.itemData;

    const projectUri = await vscode.window.withProgress(
        {
            location: { viewId: 'itsc2214ExplorerView' },
            title: `Downloading ${itemData.label}...`,
            cancellable: false
        },
        () => downloadAndUnzip(itemData, context)
    );

    if (projectUri) {
        await vscode.commands.executeCommand('vscode.openFolder', projectUri, { forceNewWindow: true });
    }
}

export async function setDownloadUrl() {
    const config = vscode.workspace.getConfiguration('itsc2214');
    const currentUrl = config.get<string>('downloadURL') || '';

    const newUrl = await vscode.window.showInputBox({
        prompt: 'Enter the assignment download URL (snarf.json)',
        value: currentUrl,
        validateInput: value => (!value || value.trim().length === 0) ? 'URL cannot be empty.' : null
    });

    if (newUrl) {
        await config.update('downloadURL', newUrl, true);
        vscode.window.showInformationMessage('Download URL updated.');
        vscode.commands.executeCommand('itsc2214.refreshAssignments');
    }
}

export async function setUploadUrl() {
    const config = vscode.workspace.getConfiguration('itsc2214');
    const currentUrl = config.get<string>('uploadURL') || '';

    const newUrl = await vscode.window.showInputBox({
        prompt: 'Enter the assignment upload URL (Web-CAT)',
        value: currentUrl,
        validateInput: value => (!value || value.trim().length === 0) ? 'URL cannot be empty.' : null
    });

    if (newUrl) {
        await config.update('uploadURL', newUrl, true);
        vscode.window.showInformationMessage('Upload URL updated.');
        vscode.commands.executeCommand('itsc2214.refreshUploads');
    }
}

export function openView() {
    vscode.commands.executeCommand('workbench.view.extension.itsc2214Explorer');
}
