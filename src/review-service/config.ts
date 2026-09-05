import * as vscode from "vscode";
import {
  isRevExtDisabled as isRevExtDisabledForSource,
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

/** Whether RevExt identity comments are disabled for a source's extension. */
export function isRevExtDisabled(uri: vscode.Uri): boolean {
  const disabledExtensions = vscode.workspace
    .getConfiguration("codeReviewTracker", uri)
    .get<string[]>(REVEXT_DISABLED_EXTENSIONS_SETTING, []);
  return isRevExtDisabledForSource(uri, disabledExtensions);
}
