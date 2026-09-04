import * as vscode from "vscode";
import {
  digestBytes,
  newlyAddedLineNumbers,
  physicalLines,
  updateAddedLineDigests,
  type FileRecord,
} from "./domain";
import { GitService } from "./git";
import { PersistentStore } from "./store";
import { revExtEdits } from "./revext";
import {
  diffWithProgress,
  readStableSource,
  type PreparedSource,
} from "./source-io";

export interface RevExtAnnotationContext {
  readonly git: GitService;
  readonly internalSaves: Set<string>;
  readonly openDocumentForInternalUse: (
    uri: vscode.Uri,
  ) => Promise<vscode.TextDocument>;
  readonly maxSize: () => number;
  readonly isEligibleSource: (uri: vscode.Uri) => Promise<boolean>;
  readonly isRevExtDisabled: (uri: vscode.Uri) => boolean;
  readonly relativePath: (uri: vscode.Uri) => string | undefined;
  readonly storeFor: (uri: vscode.Uri) => PersistentStore | undefined;
  readonly recompute: (
    uri: vscode.Uri,
    forceDigest: boolean,
    createMissing?: boolean,
    prepared?: PreparedSource,
    previous?: FileRecord,
  ) => Promise<boolean>;
}

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
    return context.recompute(uri, true, true, {
      ...prepared,
      rawHunks: hunks,
    });
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
    return context.recompute(uri, true, true, {
      ...prepared,
      rawHunks: hunks,
    });
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
  const annotatedHunks = await diffWithProgress(
    context.git,
    baseline,
    annotated.bytes,
    context.relativePath(uri) ?? uri.fsPath,
  );
  const previous = updateAddedLineDigests(
    { ...existing, nextRevExtId: annotation.nextId },
    prepared.bytes,
    annotated.bytes,
    addedLines,
    new Set(annotation.edits.map((change) => change.line)),
  );
  return context.recompute(
    uri,
    true,
    true,
    { ...annotated, rawHunks: annotatedHunks },
    previous,
  );
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
    return context.recompute(document.uri, true, true, {
      ...prepared,
      rawHunks: hunks,
    });
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
  const annotatedHunks = await diffWithProgress(
    context.git,
    baseline,
    annotated.bytes,
    context.relativePath(document.uri) ?? document.uri.fsPath,
  );
  const previous = updateAddedLineDigests(
    { ...existing, nextRevExtId: annotation.nextId },
    beforeBytes,
    annotated.bytes,
    addedLines,
    new Set(annotation.edits.map((change) => change.line)),
  );
  return context.recompute(
    document.uri,
    true,
    true,
    { ...annotated, rawHunks: annotatedHunks },
    previous,
  );
}

/** Add RevExt identity comments to every line when a file starts pending. */
export async function annotatePendingDocument(
  context: RevExtAnnotationContext,
  uri: vscode.Uri,
): Promise<number> {
  if (context.isRevExtDisabled(uri)) {
    return 1;
  }
  const document = await context.openDocumentForInternalUse(uri);
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

function addedLineNumbers(
  hunks: readonly { readonly newStart: number; readonly newCount: number }[],
): Set<number> {
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
  return addedLines;
}

function sourceLines(bytes: Uint8Array): readonly string[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return physicalLines(bytes).map((line) => {
    let text = decoder.decode(line.bytes);
    if (text.endsWith("\n")) {
      text = text.slice(0, -1);
    }
    if (text.endsWith("\r")) {
      text = text.slice(0, -1);
    }
    return text;
  });
}

function applyByteEdits(
  bytes: Uint8Array,
  edits: readonly { readonly line: number; readonly suffix: string }[],
): Uint8Array {
  const lines = physicalLines(bytes);
  const encoder = new TextEncoder();
  const insertions: { readonly offset: number; readonly bytes: Uint8Array }[] = [];
  const lineOffsets = new Map<number, number>();
  let lineOffset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    lineOffsets.set(index + 1, lineOffset);
    lineOffset += lines[index]!.bytes.length;
  }
  for (const edit of edits) {
    const line = lines[edit.line - 1];
    const offset = lineOffsets.get(edit.line);
    if (line === undefined || offset === undefined) {
      continue;
    }
    let contentLength = line.bytes.length;
    if (line.bytes.at(-1) === 0x0a) {
      contentLength -= 1;
    }
    if (line.bytes[contentLength - 1] === 0x0d) {
      contentLength -= 1;
    }
    insertions.push({
      offset: offset + contentLength,
      bytes: encoder.encode(edit.suffix),
    });
  }
  if (insertions.length === 0) {
    return bytes;
  }
  insertions.sort((left, right) => left.offset - right.offset);
  const result = new Uint8Array(
    bytes.length + insertions.reduce((total, insertion) => total + insertion.bytes.length, 0),
  );
  let sourceOffset = 0;
  let resultOffset = 0;
  for (const insertion of insertions) {
    result.set(bytes.subarray(sourceOffset, insertion.offset), resultOffset);
    resultOffset += insertion.offset - sourceOffset;
    result.set(insertion.bytes, resultOffset);
    resultOffset += insertion.bytes.length;
    sourceOffset = insertion.offset;
  }
  result.set(bytes.subarray(sourceOffset), resultOffset);
  return result;
}
