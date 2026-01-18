import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Uri, commands, window } from 'vscode';

async function areJarsPresent(itsc2214DirUri: vscode.Uri): Promise<boolean> {
    const projectJarsUri = vscode.Uri.joinPath(itsc2214DirUri, 'JARS');
    try {
        const entries = await vscode.workspace.fs.readDirectory(projectJarsUri);
        return entries.some(entry => entry[0].endsWith('.jar') && entry[1] === vscode.FileType.File);
    } catch (error) {
        return false;
    }
}

export async function copyJarsToDir(targetBaseUri: vscode.Uri, destinationFolderName: string, context: vscode.ExtensionContext): Promise<{ success: boolean; jarsCopied: number }> {
    const itsc2214Dir = context.globalState.get<string>('itsc2214Dir');
    if (!itsc2214Dir) {
        vscode.window.showErrorMessage('ITSC2214 project directory not set. Please create a project first.');
        return { success: false, jarsCopied: 0 };
    }
    const sourceJarsUri = vscode.Uri.joinPath(vscode.Uri.file(itsc2214Dir), 'JARS');
    const targetJarsUri = vscode.Uri.joinPath(targetBaseUri, destinationFolderName);
    let jarsCopiedCount = 0;

    await vscode.workspace.fs.createDirectory(targetJarsUri);

    try {
        const jarFiles = await vscode.workspace.fs.readDirectory(sourceJarsUri);
        for (const [fileName, fileType] of jarFiles) {
            if (fileType === vscode.FileType.File && fileName.endsWith('.jar')) {
                const sourceUri = vscode.Uri.joinPath(sourceJarsUri, fileName);
                const destinationUri = vscode.Uri.joinPath(targetJarsUri, fileName);
                await vscode.workspace.fs.copy(sourceUri, destinationUri, { overwrite: true });
                jarsCopiedCount++;
            }
        }
        return { success: true, jarsCopied: jarsCopiedCount };
    } catch (error) {
        console.error('Error copying JARs:', error);
        return { success: false, jarsCopied: 0 };
    }
}

export async function setupDirectory(context: vscode.ExtensionContext) {
    const locationChoice = await window.showQuickPick([
        { label: 'Desktop', description: 'Create itsc2214 folder on your Desktop' },
        { label: 'Custom Location', description: 'Choose a folder' }
    ], { placeHolder: 'Set up your ITSC2214 projects folder' });

    if (!locationChoice) return;

    let baseUri;
    if (locationChoice.label === 'Desktop') {
        baseUri = Uri.joinPath(Uri.file(os.homedir()), 'Desktop', 'itsc2214');
    } else {
        const result = await window.showOpenDialog({ canSelectFolders: true, openLabel: 'Select Parent Folder' });
        if (result) {
            baseUri = Uri.joinPath(result[0], 'itsc2214');
        }
    }

    if (!baseUri) {
        console.error('Failed to select a setup dir'); // line and curlys could be causing error
        return;
    }
    try {
        await vscode.workspace.fs.stat(baseUri);
        window.showWarningMessage(`A folder named "itsc2214" already exists in the selected location. It will be used as the project directory.`);
    } catch {
        await vscode.workspace.fs.createDirectory(baseUri);
    }
    
    await context.globalState.update('itsc2214Dir', baseUri.fsPath);
    const result = await copyJarsFromExtension(baseUri, 'JARS', context);
    if (result.success) {
        window.showInformationMessage(`✅ ITSC2214 folder created at ${baseUri.fsPath} with ${result.jarsCopied} JARs.`);
    }
}

export async function openDirectory(context: vscode.ExtensionContext) {
    const itsc2214Dir = context.globalState.get<string>('itsc2214Dir');
    if (itsc2214Dir) {
        commands.executeCommand('revealFileInOS', Uri.file(itsc2214Dir));
    } else {
        window.showWarningMessage('ITSC2214 directory not set. Please run the setup command first.');
    }
}

export async function reinstallJars(context: vscode.ExtensionContext) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('No workspace open. Please open a project to reinstall JARs.');
        return;
    }

    const currentProjectUri = workspaceFolders[0].uri;
    const result = await copyJarsToDir(currentProjectUri, 'lib', context);
    if (result.success) {
        if (result.jarsCopied > 0) {
            vscode.window.showInformationMessage(`Successfully reinstalled ${result.jarsCopied} JARs into the current project's 'lib' folder.`);
        } else {
            vscode.window.showWarningMessage('No JARs were found to reinstall. Check your ITSC2214 folder setup.');
        }
    } else {
        vscode.window.showErrorMessage('Failed to reinstall JARs.');
    }
}

export async function createJavaProject(context: vscode.ExtensionContext) {
    let itsc2214Dir: string | undefined = context.globalState.get('itsc2214Dir');

    if (itsc2214Dir) {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(itsc2214Dir));
        } catch {
            await context.globalState.update('itsc2214Dir', undefined);
            itsc2214Dir = undefined;
        }
    }

    if (!itsc2214Dir) {
        await setupDirectory(context);
        itsc2214Dir = context.globalState.get('itsc2214Dir');
        if (!itsc2214Dir) {
            return; // User likely cancelled the setup process
        }
    }
    const itsc2214DirUri = vscode.Uri.file(itsc2214Dir);

    if (!await areJarsPresent(itsc2214DirUri)) {
        if (await vscode.window.showWarningMessage('Required JARs are missing.', { modal: true }, 'Reinstall JARs') === 'Reinstall JARs') {
            await copyJarsFromExtension(itsc2214DirUri, 'JARS', context);
        }
    }

    const projectName = await vscode.window.showInputBox({
        prompt: 'Enter a name for your new Java project',
        validateInput: value => {
            if (!value) return 'Project name cannot be empty.';
            if (/[/\\:*?"<>|]/.test(value)) return 'Invalid characters in project name.';
            return null;
        }
    });

    if (!projectName) return;

    let finalProjectName = projectName;
    let projectUri = vscode.Uri.joinPath(itsc2214DirUri, finalProjectName);

    try {
        await vscode.workspace.fs.stat(projectUri);
        // Project exists, ask to create a copy
        const choice = await vscode.window.showInformationMessage(
            `Project "${projectName}" already exists. Create a new copy?`,
            { modal: true },
            'Yes',
            'No'
        );

        if (choice === 'Yes') {
            let n = 1;
            while (true) {
                finalProjectName = `_copy_${projectName}_${n}`;
                projectUri = vscode.Uri.joinPath(itsc2214DirUri, finalProjectName);
                try {
                    await vscode.workspace.fs.stat(projectUri);
                    n++;
                } catch {
                    break; // Found an available name
                }
            }
        } else {
            return; // User chose No or closed dialog
        }
    } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
            console.error('Error checking for project directory:', error);
            vscode.window.showErrorMessage('An error occurred while checking for the project directory.');
            return;
        }
        // If file not found, it's a new project, and we can proceed.
    }
    
    const srcUri = vscode.Uri.joinPath(projectUri, 'src');
    const libUri = vscode.Uri.joinPath(projectUri, 'lib');

    await Promise.all([
        vscode.workspace.fs.createDirectory(srcUri),
        vscode.workspace.fs.createDirectory(libUri)
    ]);

    await copyJarsToDir(projectUri, 'lib', context);

    const mainJavaContent = 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, ITSC2214!");\n    }\n}';
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(srcUri, 'Main.java'), Buffer.from(mainJavaContent, 'utf8'));

    const settings = { 
        'java.project.referencedLibraries': [ 'lib/**/*.jar' ],
        'java.project.outputPath': 'bin'
    };
    const settingsUri = vscode.Uri.joinPath(projectUri, '.vscode', 'settings.json');
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(projectUri, '.vscode'));
    await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(JSON.stringify(settings, null, 4), 'utf8'));

    vscode.window.showInformationMessage(`Successfully created project ${finalProjectName}.`);
    await vscode.commands.executeCommand('vscode.openFolder', projectUri, { forceNewWindow: true });
}

export async function copyJarsFromExtension(targetBaseUri: vscode.Uri, destinationFolderName: string, context: vscode.ExtensionContext): Promise<{ success: boolean; jarsCopied: number }> {
    const extensionJarsUri = vscode.Uri.joinPath(context.extensionUri, 'JARS'); // finds save_path/JARS
    const targetJarsUri = vscode.Uri.joinPath(targetBaseUri, destinationFolderName); 
    let jarsCopiedCount = 0;

    await vscode.workspace.fs.createDirectory(targetJarsUri); // in case of missing JARS dir in target => create dir

    try {
        const jarFiles = await vscode.workspace.fs.readDirectory(extensionJarsUri);
        for (const [fileName, fileType] of jarFiles) {
            if (fileType === vscode.FileType.File && fileName.endsWith('.jar')) {
                const sourceUri = vscode.Uri.joinPath(extensionJarsUri, fileName);
                const destinationUri = vscode.Uri.joinPath(targetJarsUri, fileName);
                await vscode.workspace.fs.copy(sourceUri, destinationUri, { overwrite: true });
                jarsCopiedCount++;
            }
        }
        return { success: true, jarsCopied: jarsCopiedCount };
    } catch (error) {
        console.error('Error copying JARs:', error);
        return { success: false, jarsCopied: 0 };
    }
}
