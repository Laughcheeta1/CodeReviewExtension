import { createHash } from "node:crypto";
// RevExt: 1
export type ReviewStatus = "pending" | "inReview" | "reviewed";
export type ChangeType = "unchanged" | "added";
// RevExt: 2
export interface Reviewer {
  readonly name: string;  // RevExt: 34
  readonly email?: string;  // RevExt: 36
}  // RevExt: 38
// RevExt: 3
export interface LastReviewer {
  readonly name: string;  // RevExt: 35
  readonly email?: string;  // RevExt: 37
  readonly time: string;
}  // RevExt: 39
// RevExt: 4
export interface SourceSnapshot {
  readonly modifiedAt: number;
  readonly size: number;  // RevExt: 62
}  // RevExt: 40
// RevExt: 5
export interface BaselineDescriptor {
  readonly file: string;
  readonly digest: string;  // RevExt: 64
  readonly codec: "gzip";
  readonly size: number;  // RevExt: 63
  readonly createdAt: string;
}  // RevExt: 41
// RevExt: 6
export interface CurrentDescriptor extends SourceSnapshot {
  readonly digest: string;  // RevExt: 65
  readonly gitAlgorithm: "myers";
  readonly generatedAt: string;
}  // RevExt: 42
// RevExt: 7
export interface CurrentLineRecord {
  readonly line: number;
  readonly digest: string;  // RevExt: 66
  readonly changeType: ChangeType;
  readonly reviewStatus: ReviewStatus;  // RevExt: 69
  readonly occurrence: number;  // RevExt: 71
  readonly lastReviewer?: LastReviewer | undefined;  // RevExt: 73
}  // RevExt: 43
// RevExt: 8
export interface DeletedLineRecord {
  readonly baselineLine: number;
  readonly digest: string;  // RevExt: 67
  readonly occurrence: number;  // RevExt: 72
  readonly changeType: "deleted";
  readonly reviewStatus: ReviewStatus;  // RevExt: 70
  readonly lastReviewer?: LastReviewer | undefined;  // RevExt: 74
}  // RevExt: 44
// RevExt: 9
export interface DiffHunk {
  readonly oldStart: number;  // RevExt: 75
  readonly oldCount: number;  // RevExt: 77
  readonly newStart: number;  // RevExt: 79
  readonly newCount: number;  // RevExt: 81
}  // RevExt: 45
// RevExt: 10
export interface FileRecord {
  readonly baseline: BaselineDescriptor;
  readonly current: CurrentDescriptor;
  readonly fileStatus: ReviewStatus;
  readonly lastReviewTime?: string | undefined;
  readonly currentLines: readonly CurrentLineRecord[];
  readonly deletedLines: readonly DeletedLineRecord[];
  readonly hunks: readonly DiffHunk[];
  readonly nextRevExtId: number;
  readonly updatedAt: string;
}  // RevExt: 46
// RevExt: 11
export interface PhysicalLine {
  readonly digest: string;  // RevExt: 68
  readonly bytes: Uint8Array;
}  // RevExt: 47
// RevExt: 12
export interface RawGitHunk {
  readonly oldStart: number;  // RevExt: 76
  readonly oldCount: number;  // RevExt: 78
  readonly newStart: number;  // RevExt: 80
  readonly newCount: number;  // RevExt: 82
}  // RevExt: 48
// RevExt: 13
export const digestBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
// RevExt: 14
/** Splits exact bytes into editor-visible physical lines while retaining LF/CRLF identity. */
export function physicalLines(bytes: Uint8Array): readonly PhysicalLine[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  decoder.decode(bytes);
  const result: PhysicalLine[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) {
      continue;  // RevExt: 83
    }  // RevExt: 85
    const line = bytes.slice(start, index + 1);
    result.push({ digest: digestBytes(line), bytes: line });  // RevExt: 91
    start = index + 1;
  }  // RevExt: 93
  if (start < bytes.length) {
    const line = bytes.slice(start);
    result.push({ digest: digestBytes(line), bytes: line });  // RevExt: 92
  }  // RevExt: 94
  return result;  // RevExt: 104
}  // RevExt: 49
// RevExt: 15
export function reviewableLines(
  file: Pick<FileRecord, "currentLines" | "deletedLines">,  // RevExt: 107
): readonly (CurrentLineRecord | DeletedLineRecord)[] {
  return [
    ...file.currentLines.filter((line) => line.changeType !== "unchanged"),
    ...file.deletedLines,
  ];
}  // RevExt: 50
// RevExt: 16
export function fileStatus(
  file: Pick<FileRecord, "currentLines" | "deletedLines">,  // RevExt: 108
): ReviewStatus {
  const changed = reviewableLines(file);  // RevExt: 110
  if (
    changed.length === 0 ||
    changed.every((line) => line.reviewStatus === "reviewed")
  ) {
    return "reviewed";
  }  // RevExt: 95
  if (changed.some((line) => line.reviewStatus !== "pending")) {
    return "inReview";
  }  // RevExt: 96
  return "pending";
}  // RevExt: 51
// RevExt: 17
export function reviewCounts(
  file: Pick<FileRecord, "currentLines" | "deletedLines">,  // RevExt: 109
): {
  reviewed: number;
  total: number;
} {
  const changed = reviewableLines(file);  // RevExt: 111
  return {
    reviewed: changed.filter((line) => line.reviewStatus === "reviewed").length,
    total: changed.length,
  };
}  // RevExt: 52
// RevExt: 18
export function buildDiffRecords(
  baselineBytes: Uint8Array,
  currentBytes: Uint8Array,
  rawHunks: readonly RawGitHunk[],
  previous?: FileRecord,
): Pick<FileRecord, "currentLines" | "deletedLines" | "hunks"> {
  const baseline = physicalLines(baselineBytes);
  const current = physicalLines(currentBytes);
  const previousCurrent = groupByDigest(
    previous?.currentLines.filter((line) => line.changeType === "added") ?? [],
  );  // RevExt: 112
  const previousDeleted = new Map(
    (previous?.deletedLines ?? []).map((line) => [
      `${line.digest}:${line.baselineLine}`,
      line,
    ]),  // RevExt: 115
  );  // RevExt: 113
  const currentOccurrences = occurrences(current.map((line) => line.digest));
  const currentChangeOccurrences = new Map<string, number>();
  const deletionOccurrences = new Map<string, number>();
  const nextAdditionCounts = changedDigestCounts(current, rawHunks);
  const currentLines: CurrentLineRecord[] = [];
  const deletedLines: DeletedLineRecord[] = [];
  const hunks: DiffHunk[] = [];
  let oldCursor = 1;
  let newCursor = 1;
// RevExt: 19
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
    }  // RevExt: 86
// RevExt: 20
    const oldLines = baseline.slice(oldIndex, oldIndex + raw.oldCount);
    const newLines = current.slice(newIndex, newIndex + raw.newCount);
// RevExt: 21
    for (let index = 0; index < newLines.length; index += 1) {
      const newNumber = raw.newStart + index;
      const occurrence = nextOccurrence(
        currentChangeOccurrences,
        newLines[index]!.digest,  // RevExt: 117
      );  // RevExt: 119
      const transferred = transferAddition(
        previousCurrent,
        nextAdditionCounts,
        newLines[index]!.digest,  // RevExt: 118
        occurrence,  // RevExt: 121
      );  // RevExt: 120
      currentLines.push({
        line: newNumber,
        digest: newLines[index]!.digest,
        changeType: "added",
        reviewStatus: transferred?.reviewStatus ?? "pending",  // RevExt: 124
        occurrence,  // RevExt: 122
        lastReviewer: transferred?.lastReviewer,  // RevExt: 126
      });  // RevExt: 128
    }  // RevExt: 87
// RevExt: 22
    for (let index = 0; index < oldLines.length; index += 1) {
      const oldNumber = raw.oldStart + index;
      const digest = baselineLineDigest(oldLines[index]!.bytes, oldNumber);
      const occurrence = nextOccurrence(deletionOccurrences, digest);
      const transferred = previousDeleted.get(`${digest}:${oldNumber}`);
      deletedLines.push({
        baselineLine: oldNumber,
        digest,
        occurrence,  // RevExt: 123
        changeType: "deleted",
        reviewStatus: transferred?.reviewStatus ?? "pending",  // RevExt: 125
        lastReviewer: transferred?.lastReviewer,  // RevExt: 127
      });  // RevExt: 129
    }  // RevExt: 88
    hunks.push(raw);
    oldCursor = oldIndex + raw.oldCount + 1;
    newCursor = newIndex + raw.newCount + 1;
  }  // RevExt: 97
// RevExt: 23
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
  }  // RevExt: 98
// RevExt: 24
  currentLines.sort((a, b) => a.line - b.line);
  return { currentLines, deletedLines, hunks };
}  // RevExt: 53

/**
 * Return diff-added lines that were not already present in the saved generation.
 * A changed duplicate count is deliberately treated as ambiguous, so no
 * occurrence from that digest is selected for annotation.
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
    if (
      previousCount > 0 &&
      previousCount !== currentCounts.get(line.digest)
    ) {
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
// RevExt: 25
/** The NUL separator is unambiguous because tracked source files reject NUL bytes. */
export function baselineLineDigest(
  line: Uint8Array,
  lineNumber: number,
): string {  // RevExt: 130
  return digestBytes(
    new Uint8Array([
      ...line,
      0,
      ...new TextEncoder().encode(String(lineNumber)),
    ]),  // RevExt: 116
  );  // RevExt: 114
}  // RevExt: 54
// RevExt: 26
export function setReviewer(
  status: ReviewStatus,
  reviewer: Reviewer | undefined,
  at: string,
): LastReviewer | undefined {
  if (status === "pending") {
    return undefined;  // RevExt: 132
  }  // RevExt: 99
  if (reviewer === undefined) {
    throw new Error("A reviewer is required for non-pending decisions");
  }  // RevExt: 100
  return reviewer.email === undefined
    ? { name: reviewer.name, time: at }
    : { name: reviewer.name, email: reviewer.email, time: at };
}  // RevExt: 55
// RevExt: 27
function occurrences(digests: readonly string[]): readonly number[] {
  const seen = new Map<string, number>();
  return digests.map((digest) => {
    const next = (seen.get(digest) ?? 0) + 1;
    seen.set(digest, next);
    return next;
  });  // RevExt: 134
}  // RevExt: 56
// RevExt: 28
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
  }  // RevExt: 101
  return result;  // RevExt: 105
}  // RevExt: 57
// RevExt: 29
function changedDigestCounts(
  lines: readonly PhysicalLine[],
  hunks: readonly RawGitHunk[],
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const hunk of hunks) {
    if (hunk.newCount === 0) {
      continue;  // RevExt: 84
    }  // RevExt: 89
    for (const line of lines.slice(
      hunk.newStart - 1,
      hunk.newStart - 1 + hunk.newCount,
    )) {
      result.set(line.digest, (result.get(line.digest) ?? 0) + 1);
    }  // RevExt: 90
  }  // RevExt: 102
  return result;  // RevExt: 106
}  // RevExt: 58
// RevExt: 30
function transferAddition(
  previous: ReadonlyMap<string, readonly CurrentLineRecord[]>,
  nextCounts: ReadonlyMap<string, number>,
  digest: string,
  occurrence: number,
): CurrentLineRecord | undefined {
  const matching = previous.get(digest);
  if (matching === undefined || matching.length !== nextCounts.get(digest)) {
    return undefined;  // RevExt: 133
  }  // RevExt: 103
  return matching[occurrence - 1];
}  // RevExt: 59
// RevExt: 31
function nextOccurrence(seen: Map<string, number>, digest: string): number {
  const value = (seen.get(digest) ?? 0) + 1;
  seen.set(digest, value);
  return value;
}  // RevExt: 60
// RevExt: 32
export function terminalPayload(
  path: string,
  text: string,
  ranges: readonly {
    start: number;
    end: number;
  }[],
): string {  // RevExt: 131
  const source = text.split(/\r?\n/);
  const blocks = ranges.map((range) => {
    const last = range.end > range.start ? range.end - 1 : range.end;
    const firstOneBased = range.start + 1;
    const lastOneBased = Math.max(firstOneBased, last + 1);
    const label =
      firstOneBased === lastOneBased
        ? `${firstOneBased}`
        : `${firstOneBased} - ${lastOneBased}`;
    const content = source.slice(range.start, last + 1).join("\n");
    const backticks = Math.max(
      3,
      ...(content.match(/`+/g) ?? []).map((run) => run.length + 1),
    );
    const fence = "`".repeat(backticks);
    return `> Line ${label}, file ${path}:\n${fence}\n${content}\n${fence}\n`;
  });  // RevExt: 135
  return `${blocks.join("\n")}\n`;
}  // RevExt: 61
// RevExt: 33
