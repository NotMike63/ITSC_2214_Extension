import { commands, ExtensionContext, window, workspace } from 'vscode';
import { createJavaProject, reinstallJars, setupDirectory, openDirectory } from './projectCreator';
import { AssignmentProvider, downloadAssignment, setDownloadUrl, openView, setUploadUrl } from './assignmentProvider';
import { UploadDataProvider, uploadItem } from './uploadProvider';

export async function activate(context: ExtensionContext) {
    console.log("========Extension Activated========")

    const itsc2214Dir = context.globalState.get<string>('itsc2214Dir');
    if (!itsc2214Dir) {
        await setupDirectory(context);
    }

    const assignmentProvider = new AssignmentProvider();
    window.createTreeView('itsc2214ExplorerView', { treeDataProvider: assignmentProvider });

    const uploadProvider = new UploadDataProvider();
    window.createTreeView('itsc2214UploadView', { treeDataProvider: uploadProvider });

    workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('itsc2214.downloadURL')) {
            assignmentProvider.refresh();
        }
        if (e.affectsConfiguration('itsc2214.uploadURL')) {
            uploadProvider.refresh();
        }
    });

    context.subscriptions.push(
        commands.registerCommand('itsc2214.createJavaProject', () => createJavaProject(context)),
        commands.registerCommand('itsc2214.setupDirectory', () => setupDirectory(context)),
        commands.registerCommand('itsc2214.openDirectory', () => openDirectory(context)),
        commands.registerCommand('itsc2214.reinstallJars', () => reinstallJars(context)),
        commands.registerCommand('itsc2214.setDownloadUrl', () => setDownloadUrl()),
        commands.registerCommand('itsc2214.downloadAssignment', (item) => downloadAssignment(item, context)),
        commands.registerCommand('itsc2214.refreshAssignments', () => assignmentProvider.refresh()),
        commands.registerCommand('itsc2214.uploadProject', (item) => uploadItem(item, context)),
        commands.registerCommand('itsc2214.refreshUploads', () => uploadProvider.refresh()),
        commands.registerCommand('itsc2214.openView', openView),
        commands.registerCommand('itsc2214.setUploadUrl', setUploadUrl)
    );
}