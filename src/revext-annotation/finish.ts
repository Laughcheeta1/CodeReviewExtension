import type * as vscode from "vscode";
import {
  updateAddedLineDigests,
  type FileRecord,
  type RawGitHunk,
} from "../domain";
import { diffWithProgress, type PreparedSource } from "../source-io";
import type { RevExtAnnotationContext } from "./context";

/** Recommit a source when annotation produced no marker edits. */
export async function finishPlainSource(
  context: RevExtAnnotationContext,
  uri: vscode.Uri,
  prepared: PreparedSource,
  hunks: readonly RawGitHunk[],
): Promise<boolean> {
  return context.recompute(uri, true, true, { ...prepared, rawHunks: hunks });
}

/**
 * Rescan annotated bytes, bridge added-line decisions across the
 * marker-induced digest change, and recommit the new generation.
 */
export async function finishAnnotatedSource(
  context: RevExtAnnotationContext,
  uri: vscode.Uri,
  baseline: Uint8Array,
  existing: FileRecord,
  nextRevExtId: number,
  beforeBytes: Uint8Array,
  annotated: PreparedSource,
  addedLines: ReadonlySet<number>,
  updatedLines: ReadonlySet<number>,
): Promise<boolean> {
  const annotatedHunks = await diffWithProgress(
    context.git,
    baseline,
    annotated.bytes,
    context.relativePath(uri) ?? uri.fsPath,
  );
  const previous = updateAddedLineDigests(
    { ...existing, nextRevExtId },
    beforeBytes,
    annotated.bytes,
    addedLines,
    updatedLines,
  );
  return context.recompute(
    uri,
    true,
    true,
    { ...annotated, rawHunks: annotatedHunks },
    previous,
  );
}
