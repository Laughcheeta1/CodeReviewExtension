import * as vscode from "vscode";
import {
  digestBytes,
  physicalLines,
  type FileRecord,
} from "./domain";
import { revExtMigrationEdits } from "./revext";
import { now } from "./review-service-utils";
import { readStableSource } from "./source-io";
import { PersistentStore } from "./store";

export interface RevExtMigrationContext {
  readonly internalSaves: Set<string>;
  readonly maxSize: () => number;
  readonly isEligibleSource: (uri: vscode.Uri) => Promise<boolean>;
  readonly relativePath: (uri: vscode.Uri) => string | undefined;
  readonly storeFor: (uri: vscode.Uri) => PersistentStore | undefined;
  readonly recompute: (
    uri: vscode.Uri,
    forceDigest: boolean,
  ) => Promise<boolean>;
}

/** Convert generated line comments inside JSX without resetting review decisions. */
export async function migrateJsxDocument(
  context: RevExtMigrationContext,
  uri: vscode.Uri,
): Promise<boolean> {
  if (!(await context.isEligibleSource(uri))) {
    return false;
  }
  const path = context.relativePath(uri);
  const store = context.storeFor(uri);
  if (path === undefined || store === undefined || !store.tracksPath(path)) {
    return false;
  }
  let document = await vscode.workspace.openTextDocument(uri);
  if (document.isDirty) {
    throw new Error("Save the file before migrating JSX review markers.");
  }
  let prepared = await readStableSource(uri, context.maxSize());
  let existing = await store.load(path);
  if (existing === undefined) {
    return false;
  }
  if (digestBytes(prepared.bytes) !== existing.current.digest) {
    await context.recompute(uri, true);
    existing = await store.load(path);
    if (existing === undefined) {
      return false;
    }
    prepared = await readStableSource(uri, context.maxSize());
    document = await vscode.workspace.openTextDocument(uri);
  }
  const lines = Array.from(
    { length: document.lineCount },
    (_, index) => document.lineAt(index).text,
  );
  const edits = revExtMigrationEdits(lines, document.languageId);
  if (edits.length === 0) {
    return false;
  }
  const edit = new vscode.WorkspaceEdit();
  for (const change of edits) {
    const line = document.lineAt(change.line - 1);
    edit.replace(
      uri,
      new vscode.Range(
        line.lineNumber,
        change.start,
        line.lineNumber,
        line.range.end.character,
      ),
      change.replacement,
    );
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error("Could not migrate JSX review markers.");
  }
  context.internalSaves.add(uri.toString());
  try {
    if (!(await document.save())) {
      throw new Error("Could not save migrated JSX review markers.");
    }
  } finally {
    context.internalSaves.delete(uri.toString());
  }
  prepared = await readStableSource(uri, context.maxSize());
  if (!(await context.isEligibleSource(uri))) {
    throw new Error("Ignored files cannot be migrated for review.");
  }
  const migratedLines = new Set(edits.map((change) => change.line));
  const nextRevExtId = edits.reduce(
    (next, change) => Math.max(next, change.id + 1),
    existing.nextRevExtId,
  );
  const physical = physicalLines(prepared.bytes);
  const nextLines = existing.currentLines.map((line) => {
    if (line.changeType !== "added" || !migratedLines.has(line.line)) {
      return line;
    }
    const physicalLine = physical[line.line - 1];
    return physicalLine === undefined
      ? line
      : { ...line, digest: physicalLine.digest };
  });
  const migrated: FileRecord = {
    ...existing,
    nextRevExtId,
    currentLines: nextLines,
    current: {
      ...existing.current,
      digest: digestBytes(prepared.bytes),
      ...prepared.source,
      generatedAt: now(),
    },
    updatedAt: now(),
  };
  await store.commit(path, migrated);
  return true;
}
