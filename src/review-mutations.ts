import * as vscode from "vscode";
import {
  digestBytes,
  reviewableLines,
  setReviewer,
  type FileRecord,
  type Reviewer,
  type ReviewStatus,
} from "./domain";
import { GitService } from "./git";
import { revExtRemovals } from "./revext";
import { createRecord, readStableSource } from "./source-io";
import { initialAdditionHunks, now } from "./review-service-utils";
import { PersistentStore } from "./store";

export interface BaselineIdentity {
  readonly source: vscode.Uri;
  readonly baselineDigest: string;
  readonly currentDigest: string;
}

export interface ReviewMutationContext {
  readonly git: GitService;
  readonly internalSaves: Set<string>;
  readonly changedEmitter: vscode.EventEmitter<vscode.Uri | undefined>;
  readonly promotedEmitter: vscode.EventEmitter<vscode.Uri>;
  readonly relativePath: (uri: vscode.Uri) => string | undefined;
  readonly storeFor: (uri: vscode.Uri) => PersistentStore | undefined;
  readonly maxSize: () => number;
  readonly isEligibleSource: (uri: vscode.Uri) => Promise<boolean>;
  readonly isTrackableUri: (uri: vscode.Uri) => boolean;
  readonly recompute: (
    uri: vscode.Uri,
    forceDigest: boolean,
    createMissing?: boolean,
  ) => Promise<boolean>;
  readonly annotatePendingDocument: (uri: vscode.Uri) => Promise<number>;
}

export async function initializePendingFile(
  context: ReviewMutationContext,
  source: vscode.Uri,
): Promise<boolean> {
  const path = context.relativePath(source);
  const store = context.storeFor(source);
  if (
    path === undefined ||
    store === undefined ||
    store.initializationState !== "initialized" ||
    !store.tracksPath(path) ||
    !context.isTrackableUri(source)
  ) {
    throw new Error("This file has not been initialized for review.");
  }
  if (!(await context.isEligibleSource(source))) {
    throw new Error("Ignored files cannot be tracked for review.");
  }
  let { bytes, source: snapshot } = await readStableSource(
    source,
    context.maxSize(),
  );
  const nextRevExtId = await context.annotatePendingDocument(source);
  ({ bytes, source: snapshot } = await readStableSource(
    source,
    context.maxSize(),
  ));
  const baseline = new Uint8Array();
  if (!(await context.isEligibleSource(source))) {
    throw new Error("Ignored files cannot be tracked for review.");
  }
  await store.commit(
    path,
    {
      ...(await createRecord(
        context.git,
        path,
        baseline,
        bytes,
        snapshot,
        undefined,
        initialAdditionHunks(bytes),
      )),
      nextRevExtId,
    },
    baseline,
  );
  context.changedEmitter.fire(source);
  return true;
}

export async function requireFresh(
  context: ReviewMutationContext,
  source: vscode.Uri,
  identity?: BaselineIdentity,
  forceDigest = true,
): Promise<FileRecord> {
  await context.recompute(source, forceDigest);
  const path = context.relativePath(source);
  const file =
    path === undefined ? undefined : await context.storeFor(source)?.load(path);
  if (file === undefined) {
    throw new Error("This file has not been initialized for review.");
  }
  if (
    identity !== undefined &&
    (identity.baselineDigest !== file.baseline.digest ||
      identity.currentDigest !== file.current.digest)
  ) {
    throw new Error(
      "This review diff is stale. Reopen Code Review: Open Review Diff.",
    );
  }
  return file;
}

export async function commitReview(
  context: ReviewMutationContext,
  source: vscode.Uri,
  file: FileRecord,
): Promise<void> {
  const path = context.relativePath(source);
  const store = context.storeFor(source);
  if (path === undefined || store === undefined) {
    return;
  }
  if (!(await context.isEligibleSource(source))) {
    throw new Error("Ignored files cannot be tracked for review.");
  }
  await store.commit(path, file);
  const changes = reviewableLines(file);
  if (
    file.baseline.digest !== file.current.digest &&
    changes.length > 0 &&
    changes.every((line) => line.reviewStatus === "reviewed")
  ) {
    await promote(context, source, file);
    return;
  }
  context.changedEmitter.fire(source);
}

export async function applyReview(
  context: ReviewMutationContext,
  source: vscode.Uri,
  file: FileRecord,
  status: ReviewStatus,
  reviewer: Reviewer | undefined,
  matchesCurrent: (line: FileRecord["currentLines"][number]) => boolean,
  matchesDeleted: (line: FileRecord["deletedLines"][number]) => boolean,
): Promise<boolean> {
  const at = now();
  const lastReviewer = setReviewer(status, reviewer, at);
  const currentLines = file.currentLines.map((line) =>
    matchesCurrent(line)
      ? { ...line, reviewStatus: status, lastReviewer }
      : line,
  );
  const deletedLines = file.deletedLines.map((line) =>
    matchesDeleted(line)
      ? { ...line, reviewStatus: status, lastReviewer }
      : line,
  );
  const changed =
    currentLines.some((line, index) => line !== file.currentLines[index]) ||
    deletedLines.some((line, index) => line !== file.deletedLines[index]);
  if (!changed) {
    return false;
  }
  await commitReview(context, source, {
    ...file,
    currentLines,
    deletedLines,
    lastReviewTime: at,
    updatedAt: at,
  });
  return true;
}

export async function promote(
  context: ReviewMutationContext,
  source: vscode.Uri,
  expected: FileRecord,
): Promise<void> {
  if (!(await context.isEligibleSource(source))) {
    throw new Error("Ignored files cannot be tracked for review.");
  }
  const path = context.relativePath(source);
  const store = context.storeFor(source);
  if (path === undefined || store === undefined) {
    return;
  }
  let { bytes, source: stat } = await readStableSource(
    source,
    context.maxSize(),
  );
  if (digestBytes(bytes) !== expected.current.digest) {
    await context.recompute(source, true);
    return;
  }
  const document = await vscode.workspace.openTextDocument(source);
  const removals = revExtRemovals(
    Array.from(
      { length: document.lineCount },
      (_, index) => document.lineAt(index).text,
    ),
    new Set(
      expected.currentLines
        .filter((line) => line.changeType === "added")
        .map((line) => line.line),
    ),
    document.languageId,
  );
  if (removals.length > 0) {
    const edit = new vscode.WorkspaceEdit();
    for (const removal of removals) {
      const line = document.lineAt(removal.line - 1);
      edit.delete(
        source,
        new vscode.Range(
          line.lineNumber,
          removal.start,
          line.lineNumber,
          line.range.end.character,
        ),
      );
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error("Could not remove RevExt identity comments.");
    }
    context.internalSaves.add(source.toString());
    try {
      if (!(await document.save())) {
        throw new Error("Could not save removed RevExt identity comments.");
      }
    } finally {
      context.internalSaves.delete(source.toString());
    }
    ({ bytes, source: stat } = await readStableSource(
      source,
      context.maxSize(),
    ));
  }
  const promoted = await createRecord(
    context.git,
    path,
    bytes,
    bytes,
    stat,
    expected.lastReviewTime,
  );
  if (!(await context.isEligibleSource(source))) {
    throw new Error("Ignored files cannot be tracked for review.");
  }
  await store.commit(path, promoted, bytes);
  context.changedEmitter.fire(source);
  context.promotedEmitter.fire(source);
}
