import type { FileRecord, LastReviewer } from "../domain";

export function isReviewStatus(value: unknown): boolean {
  return value === "pending" || value === "inReview" || value === "reviewed";
}
export function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}
export function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function nonNegativeInteger(value: unknown): value is number {
  return finiteNumber(value) && Number.isInteger(value) && value >= 0;
}
export function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}
export function validRangeStart(start: unknown, count: unknown): boolean {
  return positiveInteger(start) || (start === 0 && count === 0);
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
export function isRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }
  return value
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}
export function isFileRecord(value: unknown): value is FileRecord {
  if (
    !isObject(value) ||
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
  ) {
    return false;
  }
  return (
    value.currentLines.every(
      (line) =>
        isObject(line) &&
        positiveInteger(line.line) &&
        isDigest(line.digest) &&
        (line.changeType === "unchanged" || line.changeType === "added") &&
        isReviewStatus(line.reviewStatus) &&
        positiveInteger(line.occurrence) &&
        (line.lastReviewer === undefined || isLastReviewer(line.lastReviewer)),
    ) &&
    value.deletedLines.every(
      (line) =>
        isObject(line) &&
        line.changeType === "deleted" &&
        positiveInteger(line.baselineLine) &&
        isDigest(line.digest) &&
        isReviewStatus(line.reviewStatus) &&
        positiveInteger(line.occurrence) &&
        (line.lastReviewer === undefined || isLastReviewer(line.lastReviewer)),
    ) &&
    value.hunks.every(
      (hunk) =>
        isObject(hunk) &&
        nonNegativeInteger(hunk.oldCount) &&
        validRangeStart(hunk.oldStart, hunk.oldCount) &&
        nonNegativeInteger(hunk.newCount) &&
        validRangeStart(hunk.newStart, hunk.newCount) &&
        (hunk.oldCount > 0 || hunk.newCount > 0),
    )
  );
}
export function isBaseline(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.file === "string" &&
    isDigest(value.digest) &&
    value.codec === "gzip" &&
    isTimestamp(value.createdAt) &&
    nonNegativeInteger(value.size)
  );
}
export function isCurrent(value: unknown): boolean {
  return (
    isObject(value) &&
    isDigest(value.digest) &&
    value.gitAlgorithm === "myers" &&
    isTimestamp(value.generatedAt) &&
    finiteNumber(value.modifiedAt) &&
    nonNegativeInteger(value.size)
  );
}
export function isLastReviewer(value: unknown): value is LastReviewer {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    (value.email === undefined || typeof value.email === "string") &&
    isTimestamp(value.time)
  );
}
