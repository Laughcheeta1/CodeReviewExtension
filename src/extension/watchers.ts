import * as vscode from "vscode";
import { runLogged } from "../extension-utils";
import type { GitIgnoreService } from "../git-ignore";
import type { ReviewService } from "../review-service";
import { refreshFolder } from "./startup";

/** Watch workspace files and `.gitignore` files for one folder. */
export function watchWorkspace(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  service: ReviewService,
  ignoreRules: GitIgnoreService,
  log: vscode.LogOutputChannel,
): void {
  const pattern = new vscode.RelativePattern(folder, "**/*");
  const watcher = vscode.workspace.createFileSystemWatcher(
    pattern,
    false,
    false,
    false,
  );
  const creation = watcher.onDidCreate((uri) =>
    runLogged(
      log,
      "Source creation",
      service.reconcileCreatedSource(uri),
    ),
  );
  const deletion = watcher.onDidDelete((uri) =>
    service.hideSources([uri]),
  );
  const change = watcher.onDidChange((uri) =>
    runLogged(
      log,
      "External-file reconciliation",
      service.reconcileExternalSource(uri),
    ),
  );
  const gitIgnoreWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, "**/.gitignore"),
  );
  let ignoreRefresh: Promise<void> | undefined;
  let ignoreRefreshPending = false;
  const refreshIgnoredPaths = () => {
    ignoreRefreshPending = true;
    if (ignoreRefresh !== undefined) {
      return;
    }
    ignoreRefresh = (async () => {
      do {
        ignoreRefreshPending = false;
        await refreshFolder(service, ignoreRules, log, folder, false, false);
        await service.initializeDiscoveredSources(folder);
        // An edit during the previous pass invalidates its rule snapshot.
        // Collapse bursts into a trailing pass without losing the last edit.
      } while (ignoreRefreshPending);
    })().finally(() => {
      ignoreRefresh = undefined;
      if (ignoreRefreshPending) {
        refreshIgnoredPaths();
      }
    });
    runLogged(log, "Ignore-rule refresh", ignoreRefresh);
  };
  context.subscriptions.push(
    watcher,
    creation,
    deletion,
    change,
    gitIgnoreWatcher,
    gitIgnoreWatcher.onDidCreate(refreshIgnoredPaths),
    gitIgnoreWatcher.onDidChange(refreshIgnoredPaths),
    gitIgnoreWatcher.onDidDelete(refreshIgnoredPaths),
  );
}
