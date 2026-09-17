import * as vscode from "vscode";
import type { GitIgnoreService } from "../git-ignore";
import type { ReviewService } from "../review-service";
import { eligibleWorkspacePaths } from "../workspace-discovery";
import { errorMessage } from "../extension-utils";

/**
 * Refresh ignore-rule eligibility, drop newly ignored metadata, and
 * reconcile external changes for one workspace folder.
 */
export async function refreshFolder(
  service: ReviewService,
  ignoreRules: GitIgnoreService,
  log: vscode.LogOutputChannel,
  folder: vscode.WorkspaceFolder,
  force = false,
  reconcile = true,
): Promise<void> {
  try {
    const eligible = await eligibleWorkspacePaths(folder, ignoreRules);
    service.setEligiblePaths(folder, eligible);
  } catch (error) {
    log.warn(
      `Could not refresh ignore-rule eligibility for ${folder.uri.fsPath}: ${errorMessage(error)}`,
    );
    return;
  }
  await service.cleanupIgnoredSources(folder);
  if (reconcile) {
    await service.reconcileExternalChanges(folder, force);
  }
}

/** Startup pass: drop missing metadata, refresh, and seed discoveries. */
export async function startupReconcile(
  service: ReviewService,
  ignoreRules: GitIgnoreService,
  log: vscode.LogOutputChannel,
): Promise<void> {
  await Promise.all(
    (vscode.workspace.workspaceFolders ?? []).map(async (folder) => {
      await service.cleanupMissingSources(folder);
      await refreshFolder(service, ignoreRules, log, folder);
      await service.initializeDiscoveredSources(folder);
    }),
  );
}
