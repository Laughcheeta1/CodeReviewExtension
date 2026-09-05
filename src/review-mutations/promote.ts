import * as vscode from "vscode";
import { digestBytes, type FileRecord } from "../domain";
import { revExtRemovals } from "../revext";
import { createRecord, readStableSource } from "../source-io";
import type { ReviewMutationContext } from "./context";

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
  const document = await context.openDocumentForInternalUse(source);
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
