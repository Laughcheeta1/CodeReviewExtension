import * as vscode from "vscode";
import { GitService } from "./git";

/**
 * Enumerate files in a workspace that are eligible for review tracking.
 *
 * The tracker deliberately leaves the filesystem discovery to VS Code and
 * delegates only Git-specific filtering to GitService.  Keeping this in one
 * helper prevents activation-time discovery and later refreshes from drifting
 * in their excluded-path or .gitignore behavior.
 */
export async function eligibleWorkspacePaths(
  folder: vscode.WorkspaceFolder,
  git: GitService,
): Promise<readonly string[]> {
  const excluded = new vscode.RelativePattern(
    folder,
    "**/{.git,node_modules,.vscode/code-review-tracker}/**",
  );
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, "**/*"),
    excluded,
  );
  const paths = uris.map((uri) =>
    vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/"),
  );
  const ignored = await git.ignoredPaths(folder.uri.fsPath, paths);
  return paths.filter((path) => !ignored.has(path));
}
