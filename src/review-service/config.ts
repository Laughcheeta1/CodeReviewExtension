import * as vscode from "vscode";
import {
  isRevExtDisabled as isRevExtDisabledForSource,
  isRevExtIgnoredByWorkspaceConfig,
  loadRevExtWorkspaceConfigForFolderSync,
  REVEXT_DISABLED_EXTENSIONS_SETTING,
} from "../revext-config";

/** Largest file the extension will read for line review tracking. */
export function maxFileSize(): number {
  return vscode.workspace
    .getConfiguration("codeReviewTracker")
    .get<number>("maxFileSizeBytes", 1048576);
}

/** Whether deletions of lines containing only their ending are auto-accepted. */
export function ignoreEmptyLineDeletions(uri: vscode.Uri): boolean {
  return vscode.workspace
    .getConfiguration("codeReviewTracker", uri)
    .get<boolean>("ignoreEmptyLineDeletions", false);
}

/**
 * Whether RevExt identity comments are disabled for a source.
 *
 * The per-user `revExtDisabledExtensions` setting and the repo-shared
 * `.vscode/review-extension.json` file (files, folders, extensions) are
 * combined: either source disables automatic RevExt generation while review
 * metadata and tracking stay active.
 */
export function isRevExtDisabled(uri: vscode.Uri): boolean {
  const disabledExtensions = vscode.workspace
    .getConfiguration("codeReviewTracker", uri)
    .get<string[]>(REVEXT_DISABLED_EXTENSIONS_SETTING, []);
  if (isRevExtDisabledForSource(uri, disabledExtensions)) {
    return true;
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder === undefined || folder.uri.scheme !== "file") {
    return false;
  }
  if (!isUriInsideFolder(uri, folder)) {
    return false;
  }
  const relativePath = vscode.workspace
    .asRelativePath(uri, false)
    .replaceAll("\\", "/");
  const workspaceConfig = loadRevExtWorkspaceConfigForFolderSync(
    folder.uri.fsPath,
  );
  return isRevExtIgnoredByWorkspaceConfig(relativePath, workspaceConfig);
}

function isUriInsideFolder(
  uri: vscode.Uri,
  folder: vscode.WorkspaceFolder,
): boolean {
  if (uri.scheme !== "file") {
    return false;
  }
  const folderPath = folder.uri.fsPath;
  if (uri.fsPath === folderPath) {
    return false;
  }
  if (!uri.fsPath.startsWith(folderPath)) {
    return false;
  }
  const separator = uri.fsPath.slice(folderPath.length, folderPath.length + 1);
  if (separator !== "/" && separator !== "\\") {
    return false;
  }
  return true;
}
