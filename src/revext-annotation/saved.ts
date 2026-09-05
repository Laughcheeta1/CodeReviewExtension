import * as vscode from "vscode";
import { digestBytes, newlyAddedLineNumbers } from "../domain";
import { revExtEdits } from "../revext";
import { diffWithProgress, readStableSource } from "../source-io";
import type { RevExtAnnotationContext } from "./context";
import { addedLineNumbers } from "./edits";
import { finishAnnotatedSource, finishPlainSource } from "./finish";

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
  if (context.isRevExtDisabled(document.uri)) {
    return context.recompute(document.uri, true, true);
  }
  const existing = await store.load(path);
  if (existing === undefined) {
    return context.recompute(document.uri, true, true);
  }
  const prepared = await readStableSource(
    document.uri,
    context.maxSize(),
  );
  const { bytes: beforeBytes } = prepared;
  const baseline = await store.loadBaseline(existing, context.maxSize());
  const hunks = await diffWithProgress(
    context.git,
    baseline,
    beforeBytes,
    context.relativePath(document.uri) ?? document.uri.fsPath,
  );
  const addedLines = addedLineNumbers(hunks);
  const alreadyReconciled = digestBytes(beforeBytes) === existing.current.digest;
  const linesToAnnotate = alreadyReconciled
    ? addedLines
    : newlyAddedLineNumbers(beforeBytes, addedLines, existing);
  const annotation = revExtEdits(
    Array.from(
      { length: document.lineCount },
      (_, index) => document.lineAt(index).text,
    ),
    addedLines,
    document.languageId,
    existing.nextRevExtId,
    linesToAnnotate,
  );
  if (annotation.edits.length === 0) {
    return finishPlainSource(context, document.uri, prepared, hunks);
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
  if (!(await context.isEligibleSource(document.uri))) {
    return false;
  }
  const annotated = await readStableSource(
    document.uri,
    context.maxSize(),
  );
  return finishAnnotatedSource(
    context,
    document.uri,
    baseline,
    existing,
    annotation.nextId,
    beforeBytes,
    annotated,
    addedLines,
    new Set(annotation.edits.map((change) => change.line)),
  );
}
