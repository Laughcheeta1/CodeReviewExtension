import * as vscode from "vscode";
import {
  reviewableLines,
  type FileRecord,
  type Reviewer,
  type ReviewStatus,
} from "./domain";
import { PersistentStore } from "./store";
import {
  progressIncrement,
  selectedLines,
} from "./review-service-utils";
import type { BaselineIdentity } from "./review-mutations";
import { folderProgressMessage } from "./review-progress";

export interface ReviewActionContext {
  readonly parseBaselineUri: (uri: vscode.Uri) => BaselineIdentity | undefined;
  readonly isEligibleSource: (uri: vscode.Uri) => Promise<boolean>;
  readonly initializeMissingSource: (uri: vscode.Uri) => Promise<boolean>;
  readonly withSource: <T>(
    uri: vscode.Uri,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly dirtyDocument: (uri: vscode.Uri) => vscode.TextDocument | undefined;
  readonly requireFresh: (
    uri: vscode.Uri,
    identity?: BaselineIdentity,
  ) => Promise<FileRecord>;
  readonly applyReview: (
    source: vscode.Uri,
    file: FileRecord,
    status: ReviewStatus,
    reviewer: Reviewer | undefined,
    matchesCurrent: (line: FileRecord["currentLines"][number]) => boolean,
    matchesDeleted: (line: FileRecord["deletedLines"][number]) => boolean,
  ) => Promise<boolean>;
  readonly initializePendingFile: (uri: vscode.Uri) => Promise<boolean>;
  readonly storeFor: (uri: vscode.Uri) => PersistentStore | undefined;
  readonly refreshEligiblePaths: (
    folder: vscode.WorkspaceFolder,
    force?: boolean,
  ) => Promise<readonly string[] | undefined>;
}

export async function markEditor(
  context: ReviewActionContext,
  editor: vscode.TextEditor,
  status: ReviewStatus,
  reviewer?: Reviewer,
): Promise<boolean> {
  const identity = context.parseBaselineUri(editor.document.uri);
  const source = identity?.source ?? editor.document.uri;
  const selected = selectedLines(editor.selections);
  if (!(await context.isEligibleSource(source))) {
    throw new Error("Ignored files cannot be tracked for review.");
  }
  await context.initializeMissingSource(source);
  return context.withSource(source, async () => {
    if (context.dirtyDocument(source) !== undefined) {
      throw new Error("Save the file before changing review state.");
    }
    const file = await context.requireFresh(source, identity);
    return context.applyReview(
      source,
      file,
      status,
      reviewer,
      (line) =>
        identity === undefined &&
        line.changeType !== "unchanged" &&
        selected.has(line.line),
      (line) => identity !== undefined && selected.has(line.baselineLine),
    );
  });
}

export async function markFile(
  context: ReviewActionContext,
  source: vscode.Uri,
  status: ReviewStatus,
  reviewer?: Reviewer,
): Promise<boolean> {
  if (!(await context.isEligibleSource(source))) {
    throw new Error("Ignored files cannot be tracked for review.");
  }
  await context.initializeMissingSource(source);
  return context.withSource(source, async () => {
    if (context.dirtyDocument(source) !== undefined) {
      throw new Error("Save the file before changing review state.");
    }
    const file = await context.requireFresh(source);
    if (status === "pending" && reviewableLines(file).length === 0) {
      return context.initializePendingFile(source);
    }
    return context.applyReview(
      source,
      file,
      status,
      reviewer,
      (line) => line.changeType !== "unchanged",
      () => true,
    );
  });
}

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
  const folderPath = vscode.workspace
    .asRelativePath(uri, false)
    .replaceAll("\\", "/");
  const prefix = folderPath.length === 0 ? "" : `${folderPath}/`;
  let eligible = await context.refreshEligiblePaths(folder);
  if (eligible === undefined) {
    return 0;
  }
  let candidates = eligible.filter((path) => path.startsWith(prefix));
  if (candidates.length === 0) {
    eligible = await context.refreshEligiblePaths(folder, true);
    if (eligible === undefined) {
      return 0;
    }
    candidates = eligible.filter((path) => path.startsWith(prefix));
  }
  if (candidates.length === 0) {
    return 0;
  }
  await store.includeTrackingTarget({ kind: "folder", path: folderPath });
  const paths = candidates.filter((path) => store.tracksPath(path)).sort();
  if (paths.length === 0) {
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
        message: folderProgressMessage(marked, paths.length, status),
      });
      for (const path of paths) {
        try {
          const source = vscode.Uri.joinPath(folder.uri, ...path.split("/"));
          if (await markFile(context, source, status, reviewer)) {
            marked += 1;
          }
        } finally {
          progress.report({
            increment: progressIncrement(paths.length),
            message: folderProgressMessage(marked, paths.length, status),
          });
        }
      }
      return marked;
    },
  );
}
