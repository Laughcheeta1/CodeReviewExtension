import * as vscode from "vscode";
import { GitIgnoreService } from "./git-ignore";

/**
 * Enumerate files in a workspace that are eligible for review tracking.
 *
 * The tracker deliberately leaves filesystem discovery and ignore evaluation
 * to the extension. Keeping this in one helper prevents activation-time
 * discovery and later refreshes from drifting in their excluded-path or
 * .gitignore behavior.
 */
export async function eligibleWorkspacePaths(
  folder: vscode.WorkspaceFolder,
  ignoreRules: GitIgnoreService,
): Promise<readonly string[]> {
  const excluded = new vscode.RelativePattern(
    folder,
    "**/{.git,node_modules,.vscode-test,.vscode/code-review-tracker}/**",
  );
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, "**/*"),
    excluded,
  );
  const paths = uris.map((uri) =>
    vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/"),
  );
  await ignoreRules.refresh(folder);
  const ignored = await ignoreRules.ignoredPaths(folder, paths);
  return paths.filter((path) => !ignored.has(path));
}
