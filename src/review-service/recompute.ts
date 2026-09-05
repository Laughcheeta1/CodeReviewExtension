import * as vscode from "vscode";
import {
  buildDiffRecords,
  digestBytes,
  initialStatusCallback,
  type FileRecord,
  type RawGitHunk,
  type ReviewStatus,
} from "../domain";
import type { GitService } from "../git";
import {
  initialAdditionHunks,
  now,
} from "../review-service-utils";
import {
  createRecord,
  diffWithProgress,
  readStableSource,
  type PreparedSource,
} from "../source-io";
import { sourceMayHaveChanged } from "../storage-format";
import type { PersistentStore } from "../store";

export interface RecomputeDeps {
  readonly git: GitService;
  readonly log: vscode.LogOutputChannel;
  isEligibleSource(uri: vscode.Uri): Promise<boolean>;
  relativePath(uri: vscode.Uri): string | undefined;
  storeFor(uri: vscode.Uri): PersistentStore | undefined;
  maxSize(): number;
  ignoreEmptyLineDeletions(uri: vscode.Uri): boolean;
  promoteFile(uri: vscode.Uri, file: FileRecord): Promise<void>;
}

/**
 * The common recomputation pipeline: final eligibility gate, fast stat
 * path, stable read, Git diff, record rebuild, and atomic commit.
 */
export async function recomputeSource(
  deps: RecomputeDeps,
  uri: vscode.Uri,
  forceDigest: boolean,
  createMissing = false,
  prepared?: PreparedSource,
  previous?: FileRecord,
  rebuildPolicy = false,
): Promise<boolean> {
  // Re-check the current ignore-rule snapshot at the final recomputation
  // boundary. All callers also perform an eligibility check, but this guard
  // prevents a stale lifecycle decision from creating metadata.
  if (!(await deps.isEligibleSource(uri))) {
    return false;
  }
  const path = deps.relativePath(uri);
  const store = deps.storeFor(uri);
  if (path === undefined || store === undefined) {
    return false;
  }
  const existing = previous ?? (await store.load(path));
  if (existing === undefined) {
    if (!createMissing) {
      return false;
    }
    const { bytes, source } = await readStableSource(uri, deps.maxSize());
    const baseline = new Uint8Array();
    if (!(await deps.isEligibleSource(uri))) {
      return false;
    }
    await store.commit(
      path,
      await createRecord(
        deps.git,
        path,
        baseline,
        bytes,
        source,
        undefined,
        initialAdditionHunks(bytes),
      ),
      baseline,
    );
    return true;
  }
  let initialStat: vscode.FileStat | undefined;
  if (prepared === undefined) {
    initialStat = await vscode.workspace.fs.stat(uri);
    if (
      !forceDigest &&
      !sourceMayHaveChanged(
        initialStat.mtime,
        initialStat.size,
        existing.current,
      )
    ) {
      return false;
    }
  }
  const { bytes, source } =
    prepared ?? (await readStableSource(uri, deps.maxSize(), initialStat));
  const digest = digestBytes(bytes);
  const policyNeedsRebuild =
    rebuildPolicy && existing.baseline.digest !== existing.current.digest;
  if (digest === existing.current.digest && !policyNeedsRebuild) {
    if (
      source.modifiedAt === existing.current.modifiedAt &&
      source.size === existing.current.size
    ) {
      return false;
    }
    if (!(await deps.isEligibleSource(uri))) {
      return false;
    }
    await store.commit(path, {
      ...existing,
      current: { ...existing.current, ...source },
      updatedAt: now(),
    });
    return true;
  }
  const baseline = await store.loadBaseline(existing, deps.maxSize());
  const rawHunks =
    prepared?.rawHunks ??
    (await diffWithProgress(
      deps.git,
      baseline,
      bytes,
      deps.relativePath(uri) ?? uri.fsPath,
    ));
  const ignoreEmptyLineDeletions = deps.ignoreEmptyLineDeletions(uri);
  const initialStatusForAddition = await resolveInitialStatusForAdditions(
    deps,
    uri,
    path,
    rawHunks,
  );
  const diff = buildDiffRecords(
    baseline,
    bytes,
    rawHunks,
    existing,
    { ignoreEmptyLineDeletions, initialStatusForAddition },
  );
  if (!(await deps.isEligibleSource(uri))) {
    return false;
  }
  const nextFile: FileRecord = {
    ...existing,
    ...diff,
    current: {
      digest,
      ...source,
      gitAlgorithm: "myers",
      generatedAt: now(),
    },
    updatedAt: now(),
  };
  if (
    ignoreEmptyLineDeletions &&
    existing.baseline.digest !== digest &&
    diff.hunks.length === 0
  ) {
    await deps.promoteFile(uri, nextFile);
    return true;
  }
  await store.commit(path, nextFile);
  return true;
}

/**
 * Resolve the blame-based initial status for genuinely new additions.
 *
 * The snapshot diff remains the authority for what changed. This helper
 * blames the current file once (never once per line) and returns a
 * line-number callback for `buildDiffRecords`. Any failure, missing
 * identity, or file without additions yields undefined so new lines stay
 * conservatively pending and existing records are preserved.
 */
async function resolveInitialStatusForAdditions(
  deps: RecomputeDeps,
  uri: vscode.Uri,
  relativePath: string,
  rawHunks: readonly RawGitHunk[],
): Promise<((currentLine: number) => ReviewStatus) | undefined> {
  let hasAdditions = false;
  for (const hunk of rawHunks) {
    if (hunk.newCount > 0) {
      hasAdditions = true;
      break;
    }
  }
  if (!hasAdditions) {
    return undefined;
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const repository = folder?.uri.fsPath;
  if (repository === undefined) {
    return undefined;
  }
  try {
    const [blame, currentUser] = await Promise.all([
      deps.git.blame(repository, relativePath),
      deps.git.reviewer(repository),
    ]);
    if (currentUser === undefined) {
      return undefined;
    }
    return initialStatusCallback(blame, currentUser);
  } catch (error) {
    deps.log.warn(
      `Git blame classification failed for ${relativePath}; new changes stay pending: ${String(error)}`,
    );
    return undefined;
  }
}
