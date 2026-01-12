import { workspace, Uri, FileSystemError } from "vscode";

export const getConfig = () => {
  return workspace.getConfiguration("itsc2214");
};

export const delay = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export async function directoryExists(uri: Uri): Promise<boolean> {
    try {
        await workspace.fs.stat(uri);
        return true;
    } catch (error) {
        if (error instanceof FileSystemError && error.code === 'FileNotFound') {
            return false;
        }
        throw error;
    }
}
