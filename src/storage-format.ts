import { createHash } from "node:crypto";
import {
  fileStatus,
  reviewCounts,
  type FileRecord,
  type LastReviewer,
  type ReviewStatus,
  type SourceSnapshot,
} from "./domain";
// RevExt: 1
export interface StoredFile {
  readonly schemaVersion: 4;
  readonly path: string;
  readonly file: FileRecord;
}  // RevExt: 7
export interface FileSummary {
  readonly status: ReviewStatus;
  readonly reviewed: number;
  readonly total: number;
  readonly source: SourceSnapshot;
  readonly baselineFile: string;
}  // RevExt: 8
export function pathHash(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}  // RevExt: 9
// RevExt: 2
export function storageFileName(path: string): string {
  return `${pathHash(path)}.json`;
}  // RevExt: 10
// RevExt: 3
export function snapshotFileName(path: string, digest: string): string {
  return `${pathHash(path)}.${digest}.gz`;
}  // RevExt: 11
// RevExt: 4
export function storedFile(path: string, file: FileRecord): StoredFile {
  return {  // RevExt: 33
    schemaVersion: 4,
    path,
    file: {
      ...file,
      currentLines: file.currentLines.map(
        ({
          line,
          digest,
          changeType,
          reviewStatus,
          occurrence,
          lastReviewer,
        }) => {
          const record = {
            line,
            digest,
            changeType,
            reviewStatus,
            occurrence,
          };
          return lastReviewer === undefined
            ? record
            : { ...record, lastReviewer };
        },
      ),
      hunks: file.hunks.map(({ oldStart, oldCount, newStart, newCount }) => ({
        oldStart,
        oldCount,
        newStart,
        newCount,
      })),
    },  // RevExt: 35
  };  // RevExt: 37
}  // RevExt: 12
export function summarize(file: FileRecord): FileSummary {
  return {  // RevExt: 34
    status: fileStatus(file),
    ...reviewCounts(file),
    source: {
      modifiedAt: file.current.modifiedAt,
      size: file.current.size,
    },  // RevExt: 36
    baselineFile: file.baseline.file,
  };  // RevExt: 38
}  // RevExt: 13
export function sourceMayHaveChanged(
  modifiedAt: number,
  size: number,
  source: SourceSnapshot | undefined,
): boolean {  // RevExt: 39
  return (  // RevExt: 42
    source === undefined ||
    modifiedAt !== source.modifiedAt ||
    size !== source.size
  );  // RevExt: 50
}  // RevExt: 14
export function parseStoredFile(value: unknown): StoredFile | undefined {
  if (  // RevExt: 59
    !isObject(value) ||  // RevExt: 64
    value.schemaVersion !== 4 ||
    !isRelativePath(value.path) ||
    !isFileRecord(value.file)
  ) {  // RevExt: 66
    return undefined;  // RevExt: 71
  }  // RevExt: 73
  if (!isConsistent(value.path, value.file)) {
    return undefined;  // RevExt: 72
  }  // RevExt: 74
  return { schemaVersion: 4, path: value.path, file: value.file };
}  // RevExt: 15
function isFileRecord(value: unknown): value is FileRecord {
  if (  // RevExt: 60
    !isObject(value) ||  // RevExt: 65
    !isTimestamp(value.updatedAt) ||
    !isReviewStatus(value.fileStatus) ||
    (value.lastReviewTime !== undefined &&
      !isTimestamp(value.lastReviewTime)) ||
    !isBaseline(value.baseline) ||
    !isCurrent(value.current) ||
    !positiveInteger(value.nextRevExtId) ||
    !Array.isArray(value.currentLines) ||
    !Array.isArray(value.deletedLines) ||
    !Array.isArray(value.hunks)
  ) {  // RevExt: 67
    return false;  // RevExt: 86
  }  // RevExt: 75
  return (  // RevExt: 43
    value.currentLines.every(
      (line) =>  // RevExt: 93
        isObject(line) &&  // RevExt: 95
        positiveInteger(line.line) &&
        isDigest(line.digest) &&  // RevExt: 97
        (line.changeType === "unchanged" || line.changeType === "added") &&
        isReviewStatus(line.reviewStatus) &&  // RevExt: 99
        positiveInteger(line.occurrence) &&  // RevExt: 101
        (line.lastReviewer === undefined || isLastReviewer(line.lastReviewer)),  // RevExt: 103
    ) &&  // RevExt: 105
    value.deletedLines.every(
      (line) =>  // RevExt: 94
        isObject(line) &&  // RevExt: 96
        line.changeType === "deleted" &&
        positiveInteger(line.baselineLine) &&
        isDigest(line.digest) &&  // RevExt: 98
        isReviewStatus(line.reviewStatus) &&  // RevExt: 100
        positiveInteger(line.occurrence) &&  // RevExt: 102
        (line.lastReviewer === undefined || isLastReviewer(line.lastReviewer)),  // RevExt: 104
    ) &&  // RevExt: 106
    value.hunks.every(
      (hunk) =>
        isObject(hunk) &&
        nonNegativeInteger(hunk.oldCount) &&
        validRangeStart(hunk.oldStart, hunk.oldCount) &&
        nonNegativeInteger(hunk.newCount) &&
        validRangeStart(hunk.newStart, hunk.newCount) &&
        (hunk.oldCount > 0 || hunk.newCount > 0),
    )  // RevExt: 108
  );  // RevExt: 51
}  // RevExt: 16
function isBaseline(value: unknown): boolean {
  return (  // RevExt: 44
    isObject(value) &&  // RevExt: 111
    typeof value.file === "string" &&
    isDigest(value.digest) &&  // RevExt: 114
    value.codec === "gzip" &&
    isTimestamp(value.createdAt) &&
    nonNegativeInteger(value.size)  // RevExt: 116
  );  // RevExt: 52
}  // RevExt: 17
function isCurrent(value: unknown): boolean {
  return (  // RevExt: 45
    isObject(value) &&  // RevExt: 112
    isDigest(value.digest) &&  // RevExt: 115
    value.gitAlgorithm === "myers" &&
    isTimestamp(value.generatedAt) &&
    finiteNumber(value.modifiedAt) &&
    nonNegativeInteger(value.size)  // RevExt: 117
  );  // RevExt: 53
}  // RevExt: 18
function isLastReviewer(value: unknown): value is LastReviewer {
  return (  // RevExt: 46
    isObject(value) &&  // RevExt: 113
    typeof value.name === "string" &&
    (value.email === undefined || typeof value.email === "string") &&
    isTimestamp(value.time)
  );  // RevExt: 54
}  // RevExt: 19
function isConsistent(path: string, file: FileRecord): boolean {
  if (file.baseline.file !== snapshotFileName(path, file.baseline.digest)) {
    return false;  // RevExt: 87
  }  // RevExt: 76
  if (file.fileStatus !== fileStatus(file)) {
    return false;  // RevExt: 88
  }  // RevExt: 77
  if (  // RevExt: 61
    !file.currentLines.every(
      (line, index) =>
        line.line === index + 1 &&
        decisionMatches(
          line.reviewStatus,
          line.lastReviewer,
          line.changeType === "unchanged",
        ),
    )  // RevExt: 109
  ) {  // RevExt: 68
    return false;  // RevExt: 89
  }  // RevExt: 78
  if (  // RevExt: 62
    !file.deletedLines.every((line) =>
      decisionMatches(line.reviewStatus, line.lastReviewer, false),
    )  // RevExt: 110
  ) {  // RevExt: 69
    return false;  // RevExt: 90
  }  // RevExt: 79
  const additions = new Set(
    file.currentLines
      .filter((line) => line.changeType === "added")
      .map((line) => line.line),
  );  // RevExt: 55
  const deletions = new Set(file.deletedLines.map((line) => line.baselineLine));
  if (deletions.size !== file.deletedLines.length) {
    return false;  // RevExt: 91
  }  // RevExt: 80
  const hunkAdditions = new Set<number>();
  const hunkDeletions = new Set<number>();
  for (const hunk of file.hunks) {
    if (
      !addRange(hunkAdditions, hunk.newStart, hunk.newCount) ||
      !addRange(hunkDeletions, hunk.oldStart, hunk.oldCount)
    ) {
      return false;  // RevExt: 118
    }  // RevExt: 120
  }  // RevExt: 81
  return (  // RevExt: 47
    sameValues(additions, hunkAdditions) && sameValues(deletions, hunkDeletions)
  );  // RevExt: 56
}  // RevExt: 20
function decisionMatches(
  status: ReviewStatus,
  lastReviewer: LastReviewer | undefined,
  unchanged: boolean,
): boolean {  // RevExt: 40
  if (unchanged) {
    return status === "reviewed" && lastReviewer === undefined;
  }  // RevExt: 82
  if (status === "pending") {
    return lastReviewer === undefined;
  }  // RevExt: 83
  return lastReviewer !== undefined;
}  // RevExt: 21
function isReviewStatus(value: unknown): boolean {
  return value === "pending" || value === "inReview" || value === "reviewed";
}  // RevExt: 22
function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}  // RevExt: 23
function isTimestamp(value: unknown): value is string {
  return (  // RevExt: 48
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&  // RevExt: 107
    Number.isFinite(Date.parse(value))
  );  // RevExt: 57
}  // RevExt: 24
function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}  // RevExt: 25
// RevExt: 5
function nonNegativeInteger(value: unknown): value is number {
  return finiteNumber(value) && Number.isInteger(value) && value >= 0;
}  // RevExt: 26
function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}  // RevExt: 27
function validRangeStart(start: unknown, count: unknown): boolean {
  return positiveInteger(start) || (start === 0 && count === 0);
}  // RevExt: 28
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}  // RevExt: 29
function isRelativePath(value: unknown): value is string {
  if (  // RevExt: 63
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {  // RevExt: 70
    return false;  // RevExt: 92
  }  // RevExt: 84
  return value
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}  // RevExt: 30
function addRange(lines: Set<number>, start: number, count: number): boolean {
  for (let line = start; line < start + count; line += 1) {
    if (lines.has(line)) {
      return false;  // RevExt: 119
    }  // RevExt: 121
    lines.add(line);
  }  // RevExt: 85
  return true;
}  // RevExt: 31
function sameValues(
  left: ReadonlySet<number>,
  right: ReadonlySet<number>,
): boolean {  // RevExt: 41
  return (  // RevExt: 49
    left.size === right.size && [...left].every((value) => right.has(value))
  );  // RevExt: 58
}  // RevExt: 32
// RevExt: 6