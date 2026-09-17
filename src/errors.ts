import * as vscode from "vscode";

/** Convert an unknown command/lifecycle failure into a user-readable message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Match the VS Code filesystem error raised for missing files. */
export function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError && error.code === "FileNotFound"
  );
}
