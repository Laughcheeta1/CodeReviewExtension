import * as vscode from "vscode";
import { newlyAddedLineNumbers } from "../domain";
import { revExtEdits } from "../revext";
import { diffWithProgress, readStableSource } from "../source-io";
import type { RevExtAnnotationContext } from "./context";
import { addedLineNumbers, applyByteEdits, sourceLines } from "./edits";
import { finishAnnotatedSource, finishPlainSource } from "./finish";

/** Reconcile a host-filesystem change and annotate duplicate added lines. */
export async function recomputeExternalSource(
  context: RevExtAnnotationContext,
  uri: vscode.Uri,
): Promise<boolean> {
  if (!(await context.isEligibleSource(uri))) {
    return false;
  }
  const path = context.relativePath(uri);
  const store = context.storeFor(uri);
  if (path === undefined || store === undefined) {
    return false;
  }
  if (context.isRevExtDisabled(uri)) {
    return context.recompute(uri, true, true);
  }
  const existing = await store.load(path);
  if (existing === undefined) {
    return context.recompute(uri, true, true);
  }

  const prepared = await readStableSource(uri, context.maxSize());
  const baseline = await store.loadBaseline(existing, context.maxSize());
  const hunks = await diffWithProgress(
    context.git,
    baseline,
    prepared.bytes,
    context.relativePath(uri) ?? uri.fsPath,
  );
  const addedLines = addedLineNumbers(hunks);
  const document = await context.openDocumentForInternalUse(uri);
  if (document.isDirty) {
    return finishPlainSource(context, uri, prepared, hunks);
  }
  const linesToAnnotate = newlyAddedLineNumbers(
    prepared.bytes,
    addedLines,
    existing,
  );
  const annotation = revExtEdits(
    sourceLines(prepared.bytes),
    addedLines,
    document.languageId,
    existing.nextRevExtId,
    linesToAnnotate,
  );
  if (annotation.edits.length === 0) {
    return finishPlainSource(context, uri, prepared, hunks);
  }

  const annotatedBytes = applyByteEdits(prepared.bytes, annotation.edits);
  if (!(await context.isEligibleSource(uri))) {
    return false;
  }
  const key = uri.toString();
  context.internalSaves.add(key);
  try {
    await vscode.workspace.fs.writeFile(uri, annotatedBytes);
  } finally {
    context.internalSaves.delete(key);
  }
  if (!(await context.isEligibleSource(uri))) {
    return false;
  }

  const annotated = await readStableSource(uri, context.maxSize());
  return finishAnnotatedSource(
    context,
    uri,
    baseline,
    existing,
    annotation.nextId,
    prepared.bytes,
    annotated,
    addedLines,
    new Set(annotation.edits.map((change) => change.line)),
  );
}
