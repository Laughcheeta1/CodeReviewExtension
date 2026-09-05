import {
  baselineLineDigest,
  isEmptyPhysicalLine,
  physicalLines,
} from "./identity";
import type {
  CurrentLineRecord,
  DeletedLineRecord,
  DiffHunk,
  DiffOptions,
  FileRecord,
  PhysicalLine,
  RawGitHunk,
} from "./types";


export function buildDiffRecords(
  baselineBytes: Uint8Array,
  currentBytes: Uint8Array,
  rawHunks: readonly RawGitHunk[],
  previous?: FileRecord,
  options: DiffOptions = {},
): Pick<FileRecord, "currentLines" | "deletedLines" | "hunks"> {
  const baseline = physicalLines(baselineBytes);
  const current = physicalLines(currentBytes);
  const previousCurrent = groupByDigest(
    previous?.currentLines.filter((line) => line.changeType === "added") ?? [],
  );
  const previousDeleted = new Map(
    (previous?.deletedLines ?? []).map((line) => [
      `${line.digest}:${line.baselineLine}`,
      line,
    ]),
  );
  const currentOccurrences = occurrences(current.map((line) => line.digest));
  const currentChangeOccurrences = new Map<string, number>();
  const deletionOccurrences = new Map<string, number>();
  const nextAdditionCounts = changedDigestCounts(current, rawHunks);
  const currentLines: CurrentLineRecord[] = [];
  const deletedLines: DeletedLineRecord[] = [];
  const ignoredDeletedLines = new Set<number>();
  let oldCursor = 1;
  let newCursor = 1;

  for (const raw of rawHunks) {
    const oldIndex = raw.oldCount === 0 ? raw.oldStart : raw.oldStart - 1;
    const newIndex = raw.newCount === 0 ? raw.newStart : raw.newStart - 1;
    while (oldCursor - 1 < oldIndex && newCursor - 1 < newIndex) {
      const line = current[newCursor - 1];
      if (line !== undefined) {
        currentLines.push({
          line: newCursor,
          digest: baselineLineDigest(baseline[oldCursor - 1]!.bytes, oldCursor),
          changeType: "unchanged",
          occurrence: currentOccurrences[newCursor - 1] ?? 1,
          reviewStatus: "reviewed",
        });
      }
      oldCursor += 1;
      newCursor += 1;
    }

    const oldLines = baseline.slice(oldIndex, oldIndex + raw.oldCount);
    const newLines = current.slice(newIndex, newIndex + raw.newCount);

    for (let index = 0; index < newLines.length; index += 1) {
      const newNumber = raw.newStart + index;
      const occurrence = nextOccurrence(
        currentChangeOccurrences,
        newLines[index]!.digest,
      );
      const transferred = transferAddition(
        previousCurrent,
        nextAdditionCounts,
        newLines[index]!.digest,
        occurrence,
      );
      currentLines.push({
        line: newNumber,
        digest: newLines[index]!.digest,
        changeType: "added",
        reviewStatus: transferred?.reviewStatus ?? "pending",
        occurrence,
        lastReviewer: transferred?.lastReviewer,
      });
    }

    for (let index = 0; index < oldLines.length; index += 1) {
      const oldNumber = raw.oldStart + index;
      if (
        options.ignoreEmptyLineDeletions === true &&
        isEmptyPhysicalLine(oldLines[index]!.bytes)
      ) {
        ignoredDeletedLines.add(oldNumber);
        continue;
      }
      const digest = baselineLineDigest(oldLines[index]!.bytes, oldNumber);
      const occurrence = nextOccurrence(deletionOccurrences, digest);
      const transferred = previousDeleted.get(`${digest}:${oldNumber}`);
      deletedLines.push({
        baselineLine: oldNumber,
        digest,
        occurrence,
        changeType: "deleted",
        reviewStatus: transferred?.reviewStatus ?? "pending",
        lastReviewer: transferred?.lastReviewer,
      });
    }
    oldCursor = oldIndex + raw.oldCount + 1;
    newCursor = newIndex + raw.newCount + 1;
  }

  while (newCursor <= current.length) {
    currentLines.push({
      line: newCursor,
      digest: baselineLineDigest(baseline[oldCursor - 1]!.bytes, oldCursor),
      changeType: "unchanged",
      occurrence: currentOccurrences[newCursor - 1] ?? 1,
      reviewStatus: "reviewed",
    });
    oldCursor += 1;
    newCursor += 1;
  }

  currentLines.sort((a, b) => a.line - b.line);
  return {
    currentLines,
    deletedLines,
    hunks:
      options.ignoreEmptyLineDeletions === true
        ? effectiveHunks(rawHunks, ignoredDeletedLines)
        : rawHunks,
  };
}

function occurrences(digests: readonly string[]): readonly number[] {
  const seen = new Map<string, number>();
  return digests.map((digest) => {
    const next = (seen.get(digest) ?? 0) + 1;
    seen.set(digest, next);
    return next;
  });
}

function groupByDigest<
  T extends {
    digest: string;
  },
>(records: readonly T[]): ReadonlyMap<string, readonly T[]> {
  const result = new Map<string, T[]>();
  for (const record of records) {
    const matching = result.get(record.digest) ?? [];
    matching.push(record);
    result.set(record.digest, matching);
  }
  return result;
}

function changedDigestCounts(
  lines: readonly PhysicalLine[],
  hunks: readonly RawGitHunk[],
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const hunk of hunks) {
    if (hunk.newCount === 0) {
      continue;
    }
    for (const line of lines.slice(
      hunk.newStart - 1,
      hunk.newStart - 1 + hunk.newCount,
    )) {
      result.set(line.digest, (result.get(line.digest) ?? 0) + 1);
    }
  }
  return result;
}

function effectiveHunks(
  rawHunks: readonly RawGitHunk[],
  ignoredDeletedLines: ReadonlySet<number>,
): readonly DiffHunk[] {
  if (ignoredDeletedLines.size === 0) {
    return rawHunks;
  }
  const result: DiffHunk[] = [];
  for (const hunk of rawHunks) {
    const oldRuns = contiguousRanges(
      Array.from(
        { length: hunk.oldCount },
        (_, index) => hunk.oldStart + index,
      ).filter((line) => !ignoredDeletedLines.has(line)),
    );
    if (oldRuns.length === 0) {
      if (hunk.newCount > 0) {
        result.push({ ...hunk, oldCount: 0 });
      }
      continue;
    }
    oldRuns.forEach((run, index) => {
      result.push({
        oldStart: run.start,
        oldCount: run.count,
        newStart: hunk.newStart,
        newCount: index === 0 ? hunk.newCount : 0,
      });
    });
  }
  return result;
}

function contiguousRanges(
  lines: readonly number[],
): readonly { start: number; count: number }[] {
  const result: { start: number; count: number }[] = [];
  for (const line of lines) {
    const previous = result.at(-1);
    if (previous !== undefined && previous.start + previous.count === line) {
      previous.count += 1;
    } else {
      result.push({ start: line, count: 1 });
    }
  }
  return result;
}

function transferAddition(
  previous: ReadonlyMap<string, readonly CurrentLineRecord[]>,
  nextCounts: ReadonlyMap<string, number>,
  digest: string,
  occurrence: number,
): CurrentLineRecord | undefined {
  const matching = previous.get(digest);
  if (matching === undefined || matching.length !== nextCounts.get(digest)) {
    return undefined;
  }
  return matching[occurrence - 1];
}

function nextOccurrence(seen: Map<string, number>, digest: string): number {
  const value = (seen.get(digest) ?? 0) + 1;
  seen.set(digest, value);
  return value;
}
