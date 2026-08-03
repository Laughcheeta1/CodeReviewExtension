import * as vscode from "vscode";
import {
  buildDiffRecords,
  digestBytes,
  fileStatus,
  type FileRecord,
  type RawGitHunk,
  type SourceSnapshot,
} from "./domain";
import { GitService } from "./git";
import { snapshotFileName } from "./storage-format";
import { now } from "./review-service-utils";

const decoder = new TextDecoder("utf-8", { fatal: true });

export interface PreparedSource {
  readonly bytes: Uint8Array;
  readonly source: SourceSnapshot;
  readonly rawHunks?: readonly RawGitHunk[];
}

/** Read a text source twice around its stat to avoid persisting a torn read. */
export async function readStableSource(
  uri: vscode.Uri,
  maxSize: number,
  initialStat?: vscode.FileStat,
): Promise<PreparedSource> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before =
      attempt === 0 && initialStat !== undefined
        ? initialStat
        : await vscode.workspace.fs.stat(uri);
    if (before.size > maxSize) {
      throw new Error("File exceeds the configured size limit");
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    const after = await vscode.workspace.fs.stat(uri);
    if (
      before.mtime !== after.mtime ||
      before.size !== after.size ||
      bytes.byteLength !== after.size
    ) {
      continue;
    }
    decoder.decode(bytes);
    if (bytes.includes(0)) {
      throw new Error("Binary files are unsupported");
    }
    return {
      bytes,
      source: { modifiedAt: after.mtime, size: after.size },
    };
  }
  throw new Error(`Source changed while it was being read: ${uri.toString()}`);
}

/** Calculate a Git diff while exposing VS Code progress feedback. */
export async function diffWithProgress(
  git: GitService,
  baseline: Uint8Array,
  current: Uint8Array,
  displayPath: string,
): Promise<readonly RawGitHunk[]> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Code Review: comparing ${displayPath}`,
    },
    () => git.diff(baseline, current),
  );
}

/** Build the durable metadata record shared by initialization and promotion. */
export async function createRecord(
  git: GitService,
  path: string,
  baseline: Uint8Array,
  current: Uint8Array,
  source: SourceSnapshot,
  lastReviewTime?: string,
  rawHunks?: readonly RawGitHunk[],
): Promise<FileRecord> {
  const baselineDigest = digestBytes(baseline);
  const currentDigest = digestBytes(current);
  const generatedAt = now();
  const diff = buildDiffRecords(
    baseline,
    current,
    rawHunks ??
      (baselineDigest === currentDigest ? [] : await git.diff(baseline, current)),
  );
  return {
    baseline: {
      file: snapshotFileName(path, baselineDigest),
      digest: baselineDigest,
      codec: "gzip",
      size: baseline.byteLength,
      createdAt: generatedAt,
    },
    current: {
      digest: currentDigest,
      ...source,
      gitAlgorithm: "myers",
      generatedAt,
    },
    fileStatus: fileStatus(diff),
    nextRevExtId: 1,
    lastReviewTime,
    ...diff,
    updatedAt: generatedAt,
  };
}
