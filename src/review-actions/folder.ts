import * as vscode from "vscode";
import type { Reviewer, ReviewStatus } from "../domain";
import { progressIncrement } from "../review-service-utils";
import { folderProgressMessage } from "../review-progress";
import type { ReviewActionContext } from "./context";
import { markFile } from "./file";

export async function markFolder(
  context: ReviewActionContext,
  uri: vscode.Uri,
  status: ReviewStatus,
  reviewer?: Reviewer,
): Promise<number> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const store = context.storeFor(uri);
  if (
    folder === undefined ||
    store === undefined ||
    store.initializationState !== "initialized"
  ) {
    return 0;
  }
  const paths = await folderCandidates(context, folder, uri);
  if (paths.length === 0) {
    return 0;
  }
  await store.includeTrackingTarget({
    kind: "folder",
    path: folderPrefix(uri),
  });
  const tracked = paths.filter((path) => store.tracksPath(path)).sort();
  if (tracked.length === 0) {
    return 0;
  }
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Code Review: marking folder ${status}`,
    },
    async (progress) => {
      let marked = 0;
      progress.report({
        message: folderProgressMessage(marked, tracked.length, status),
      });
      for (const path of tracked) {
        try {
          const source = vscode.Uri.joinPath(folder.uri, ...path.split("/"));
          if (await markFile(context, source, status, reviewer)) {
            marked += 1;
          }
        } finally {
          progress.report({
            increment: progressIncrement(tracked.length),
            message: folderProgressMessage(marked, tracked.length, status),
          });
        }
      }
      return marked;
    },
  );
}

function folderPrefix(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/");
}

async function folderCandidates(
  context: ReviewActionContext,
  folder: vscode.WorkspaceFolder,
  uri: vscode.Uri,
): Promise<string[]> {
  const prefix = folderPrefix(uri);
  const scoped = prefix.length === 0 ? "" : `${prefix}/`;
  let eligible = await context.refreshEligiblePaths(folder);
  if (eligible === undefined) {
    return [];
  }
  let candidates = eligible.filter((path) => path.startsWith(scoped));
  if (candidates.length > 0) {
    return candidates;
  }
  eligible = await context.refreshEligiblePaths(folder, true);
  if (eligible === undefined) {
    return [];
  }
  candidates = eligible.filter((path) => path.startsWith(scoped));
  return candidates;
}
