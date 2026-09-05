import { physicalLines } from "./identity";
import type { FileRecord } from "./types";

/**
 * Return diff-added lines that need duplicate identity comments.
 *
 * Review-state transfer remains conservative when a duplicate count changes,
 * but annotation must still begin as soon as a second equal addition exists.
 * Selecting the current duplicate group lets `revExtEdits` preserve existing
 * markers and add markers only to its untagged peers.
 */
export function newlyAddedLineNumbers(
  currentBytes: Uint8Array,
  addedLines: ReadonlySet<number>,
  previous: Pick<FileRecord, "currentLines">,
): ReadonlySet<number> {
  const current = physicalLines(currentBytes);
  const previousAdded = new Set<string>();
  const previousCounts = new Map<string, number>();
  for (const line of previous.currentLines) {
    if (line.changeType !== "added") {
      continue;
    }
    previousAdded.add(`${line.digest}:${line.occurrence}`);
    previousCounts.set(
      line.digest,
      (previousCounts.get(line.digest) ?? 0) + 1,
    );
  }
  const addedLineNumbers = [...addedLines].sort((a, b) => a - b);
  const occurrences = new Map<string, number>();
  const currentCounts = new Map<string, number>();
  const occurrenceByLine = new Map<number, number>();
  for (const lineNumber of addedLineNumbers) {
    const line = current[lineNumber - 1];
    if (line === undefined) {
      continue;
    }
    const occurrence = (occurrences.get(line.digest) ?? 0) + 1;
    occurrences.set(line.digest, occurrence);
    occurrenceByLine.set(lineNumber, occurrence);
    currentCounts.set(
      line.digest,
      (currentCounts.get(line.digest) ?? 0) + 1,
    );
  }
  const result = new Set<number>();
  for (const lineNumber of addedLineNumbers) {
    const line = current[lineNumber - 1];
    const occurrence = occurrenceByLine.get(lineNumber);
    if (line === undefined || occurrence === undefined) {
      continue;
    }
    const previousCount = previousCounts.get(line.digest) ?? 0;
    const currentCount = currentCounts.get(line.digest) ?? 0;
    if (previousCount > 0 && previousCount !== currentCount) {
      if (currentCount >= 2) {
        result.add(lineNumber);
      }
      continue;
    }
    if (!previousAdded.has(`${line.digest}:${occurrence}`)) {
      result.add(lineNumber);
    }
  }
  return result;
}

/** Preserve added-line decisions across an internal suffix-only source rewrite. */
export function updateAddedLineDigests(
  previous: FileRecord,
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
  addedLines: ReadonlySet<number>,
  updatedLines: ReadonlySet<number>,
): FileRecord {
  const before = physicalLines(beforeBytes);
  const after = physicalLines(afterBytes);
  const addedOccurrences = new Map<string, number>();
  const occurrenceByLine = new Map<number, number>();
  for (const lineNumber of [...addedLines].sort((a, b) => a - b)) {
    const line = before[lineNumber - 1];
    if (line === undefined) {
      continue;
    }
    const occurrence = (addedOccurrences.get(line.digest) ?? 0) + 1;
    addedOccurrences.set(line.digest, occurrence);
    occurrenceByLine.set(lineNumber, occurrence);
  }

  const digestUpdates = new Map<string, string>();
  for (const lineNumber of [...updatedLines].sort((a, b) => a - b)) {
    if (!addedLines.has(lineNumber)) {
      continue;
    }
    const beforeLine = before[lineNumber - 1];
    const afterLine = after[lineNumber - 1];
    const occurrence = occurrenceByLine.get(lineNumber);
    if (
      beforeLine === undefined ||
      afterLine === undefined ||
      occurrence === undefined
    ) {
      continue;
    }
    const matching = previous.currentLines.find(
      (line) =>
        line.changeType === "added" &&
        line.digest === beforeLine.digest &&
        line.occurrence === occurrence,
    );
    if (matching !== undefined) {
      digestUpdates.set(
        `${matching.digest}:${matching.occurrence}`,
        afterLine.digest,
      );
    }
  }
  if (digestUpdates.size === 0) {
    return previous;
  }
  return {
    ...previous,
    currentLines: previous.currentLines.map((line) => {
      const digest = digestUpdates.get(`${line.digest}:${line.occurrence}`);
      return digest === undefined ? line : { ...line, digest };
    }),
  };
}
