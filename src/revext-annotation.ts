import * as vscode from "vscode";
import { GitService } from "./git";
import { PersistentStore } from "./store";
import { revExtEdits } from "./revext";
import { diffWithProgress, readStableSource } from "./source-io";
import { now } from "./review-service-utils";

export interface RevExtAnnotationContext {
  readonly git: GitService;
  readonly internalSaves: Set<string>;
  readonly maxSize: () => number;
  readonly isEligibleSource: (uri: vscode.Uri) => Promise<boolean>;
  readonly relativePath: (uri: vscode.Uri) => string | undefined;
  readonly storeFor: (uri: vscode.Uri) => PersistentStore | undefined;
  readonly recompute: (
    uri: vscode.Uri,
    forceDigest: boolean,
    createMissing?: boolean,
  ) => Promise<boolean>;
}

/** Reconcile a save, adding identity comments only where changed lines need them. */
export async function recomputeSavedDocument(
  context: RevExtAnnotationContext,
  document: vscode.TextDocument,
): Promise<boolean> {
  if (!(await context.isEligibleSource(document.uri))) {
    return false;
  }
  const path = context.relativePath(document.uri);
  const store = context.storeFor(document.uri);
  if (path === undefined || store === undefined) {
    return false;
  }
  const existing = await store.load(path);
  if (existing === undefined) {
    return context.recompute(document.uri, true, true);
  }
  const { bytes } = await readStableSource(
    document.uri,
    context.maxSize(),
  );
  const baseline = await store.loadBaseline(existing, context.maxSize());
  const hunks = await diffWithProgress(
    context.git,
    baseline,
    bytes,
    context.relativePath(document.uri) ?? document.uri.fsPath,
  );
  const addedLines = new Set<number>();
  for (const hunk of hunks) {
    for (
      let line = hunk.newStart;
      line < hunk.newStart + hunk.newCount;
      line += 1
    ) {
      addedLines.add(line);
    }
  }
  const annotation = revExtEdits(
    Array.from(
      { length: document.lineCount },
      (_, index) => document.lineAt(index).text,
    ),
    addedLines,
    document.languageId,
    existing.nextRevExtId,
  );
  if (annotation.edits.length === 0) {
    return context.recompute(document.uri, true, true);
  }
  const edit = new vscode.WorkspaceEdit();
  for (const change of annotation.edits) {
    const line = document.lineAt(change.line - 1);
    edit.insert(document.uri, line.range.end, change.suffix);
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error("Could not add RevExt identity comments.");
  }
  context.internalSaves.add(document.uri.toString());
  try {
    if (!(await document.save())) {
      throw new Error("Could not save RevExt identity comments.");
    }
  } finally {
    context.internalSaves.delete(document.uri.toString());
  }
  const changed = await context.recompute(document.uri, true, true);
  const updated = await store.load(path);
  if (
    updated !== undefined &&
    updated.nextRevExtId !== annotation.nextId &&
    (await context.isEligibleSource(document.uri))
  ) {
    await store.commit(path, {
      ...updated,
      nextRevExtId: annotation.nextId,
      updatedAt: now(),
    });
  }
  return changed;
}

/** Add RevExt identity comments to every line when a file starts pending. */
export async function annotatePendingDocument(
  context: RevExtAnnotationContext,
  uri: vscode.Uri,
): Promise<number> {
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.isDirty) {
    throw new Error("Save the file before starting pending review.");
  }
  const annotation = revExtEdits(
    Array.from(
      { length: document.lineCount },
      (_, index) => document.lineAt(index).text,
    ),
    new Set(Array.from({ length: document.lineCount }, (_, index) => index + 1)),
    document.languageId,
    1,
  );
  if (annotation.edits.length === 0) {
    return annotation.nextId;
  }
  const edit = new vscode.WorkspaceEdit();
  for (const change of annotation.edits) {
    const line = document.lineAt(change.line - 1);
    edit.insert(uri, line.range.end, change.suffix);
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error("Could not add initial RevExt identity comments.");
  }
  context.internalSaves.add(uri.toString());
  try {
    if (!(await document.save())) {
      throw new Error("Could not save initial RevExt identity comments.");
    }
  } finally {
    context.internalSaves.delete(uri.toString());
  }
  return annotation.nextId;
}
