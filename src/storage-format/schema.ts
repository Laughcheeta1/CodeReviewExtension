import { fileStatus, type FileRecord, type ReviewStatus } from "../domain";
import type { LastReviewer } from "../domain";
import { snapshotFileName } from "./naming";
import type { StoredFile } from "./record";
import { isFileRecord, isObject, isRelativePath } from "./validate";

export function parseStoredFile(value: unknown): StoredFile | undefined {
  if (
    !isObject(value) ||
    value.schemaVersion !== 4 ||
    !isRelativePath(value.path) ||
    !isFileRecord(value.file)
  ) {
    return undefined;
  }
  if (!isConsistent(value.path, value.file)) {
    return undefined;
  }
  return { schemaVersion: 4, path: value.path, file: value.file };
}

/**
 * Explain why a persisted value fails v4 validation.
 *
 * `parseStoredFile` intentionally returns undefined for malformed input, but
 * that gives operators no way to distinguish a wrong schema version from a
 * reviewer-attribution mismatch or a hunk-coverage drift. This helper mirrors
 * every check in `parseStoredFile`/`isConsistent` and returns the first
 * human-readable reason, including the offending path, line numbers, and
 * expected vs actual digests/statuses. Store and lifecycle logs include this
 * detail so an "Invalid v4" failure names the exact invariant that broke.
 */
export function describeStoredFileProblem(
  value: unknown,
  expectedPath?: string,
): string {
  if (!isObject(value)) {
    return "stored value is not a JSON object";
  }
  if (value.schemaVersion !== 4) {
    return `unsupported schemaVersion ${String(value.schemaVersion)} (expected 4)`;
  }
  if (!isRelativePath(value.path)) {
    return `stored path ${JSON.stringify(value.path)} is not a normalized workspace-relative path`;
  }
  if (expectedPath !== undefined && value.path !== expectedPath) {
    return `stored path "${value.path}" does not match expected path "${expectedPath}" (metadata file is named for a different source)`;
  }
  if (!isFileRecord(value.file)) {
    return `file record for "${value.path}" has a malformed baseline/current/lines/hunks shape`;
  }
  const path = value.path;
  const file = value.file;
  const expectedSnapshot = snapshotFileName(path, file.baseline.digest);
  if (file.baseline.file !== expectedSnapshot) {
    return (
      `snapshot name mismatch for "${path}": stored "${file.baseline.file}" ` +
      `but expected "${expectedSnapshot}" for baseline digest ${file.baseline.digest}`
    );
  }
  const expectedStatus = fileStatus(file);
  if (file.fileStatus !== expectedStatus) {
    return (
      `fileStatus mismatch for "${path}": stored "${file.fileStatus}" ` +
      `but derived "${expectedStatus}" from ${file.currentLines.length} current and ${file.deletedLines.length} deleted lines`
    );
  }
  for (let index = 0; index < file.currentLines.length; index += 1) {
    const line = file.currentLines[index]!;
    if (line.line !== index + 1) {
      return (
        `current-line ordering mismatch for "${path}" at index ${index}: ` +
        `stored line ${line.line} but expected ${index + 1} (lines must be dense and 1-based)`
      );
    }
    if (!decisionMatches(line.reviewStatus, line.lastReviewer, line.changeType === "unchanged")) {
      if (line.changeType === "unchanged") {
        return (
          `unchanged line ${line.line} for "${path}" must be reviewed without a reviewer, ` +
          `but has status "${line.reviewStatus}" with${line.lastReviewer === undefined ? "out" : ""} reviewer attribution`
        );
      }
      if (line.reviewStatus === "pending") {
        return (
          `pending added line ${line.line} for "${path}" must not carry a reviewer, ` +
          `but has reviewer ${JSON.stringify(line.lastReviewer)}`
        );
      }
      return (
        `non-pending added line ${line.line} for "${path}" has status "${line.reviewStatus}" ` +
        `but no lastReviewer (every inReview/reviewed change needs reviewer attribution with name and time)`
      );
    }
  }
  for (const line of file.deletedLines) {
    if (!decisionMatches(line.reviewStatus, line.lastReviewer, false)) {
      if (line.reviewStatus === "pending") {
        return (
          `pending deleted baseline line ${line.baselineLine} for "${path}" must not carry a reviewer, ` +
          `but has reviewer ${JSON.stringify(line.lastReviewer)}`
        );
      }
      return (
        `non-pending deleted baseline line ${line.baselineLine} for "${path}" has status ` +
        `"${line.reviewStatus}" but no lastReviewer (every inReview/reviewed change needs reviewer attribution)`
      );
    }
  }
  const additions = new Set(
    file.currentLines
      .filter((line) => line.changeType === "added")
      .map((line) => line.line),
  );
  const deletions = new Set(file.deletedLines.map((line) => line.baselineLine));
  if (deletions.size !== file.deletedLines.length) {
    return `duplicate deleted baseline lines for "${path}" (${file.deletedLines.length} records but ${deletions.size} distinct baseline lines)`;
  }
  const hunkAdditions = new Set<number>();
  const hunkDeletions = new Set<number>();
  for (const hunk of file.hunks) {
    if (!addRange(hunkAdditions, hunk.newStart, hunk.newCount)) {
      return (
        `overlapping new-side hunk coverage for "${path}" at newStart=${hunk.newStart} ` +
        `newCount=${hunk.newCount} (added lines: [${[...additions].sort((a, b) => a - b).join(", ")}])`
      );
    }
    if (!addRange(hunkDeletions, hunk.oldStart, hunk.oldCount)) {
      return (
        `overlapping old-side hunk coverage for "${path}" at oldStart=${hunk.oldStart} ` +
        `oldCount=${hunk.oldCount} (deleted lines: [${[...deletions].sort((a, b) => a - b).join(", ")}])`
      );
    }
  }
  if (!sameValues(additions, hunkAdditions) || !sameValues(deletions, hunkDeletions)) {
    return (
      `hunk coverage mismatch for "${path}": added lines [${[...additions].sort((a, b) => a - b).join(", ")}] ` +
      `vs hunk new-side [${[...hunkAdditions].sort((a, b) => a - b).join(", ")}]; ` +
      `deleted lines [${[...deletions].sort((a, b) => a - b).join(", ")}] ` +
      `vs hunk old-side [${[...hunkDeletions].sort((a, b) => a - b).join(", ")}]`
    );
  }
  return "unknown v4 validation failure (value passed every individual check)";
}
function isConsistent(path: string, file: FileRecord): boolean {
  if (file.baseline.file !== snapshotFileName(path, file.baseline.digest)) {
    return false;
  }
  if (file.fileStatus !== fileStatus(file)) {
    return false;
  }
  if (
    !file.currentLines.every(
      (line, index) =>
        line.line === index + 1 &&
        decisionMatches(
          line.reviewStatus,
          line.lastReviewer,
          line.changeType === "unchanged",
        ),
    )
  ) {
    return false;
  }
  if (
    !file.deletedLines.every((line) =>
      decisionMatches(line.reviewStatus, line.lastReviewer, false),
    )
  ) {
    return false;
  }
  const additions = new Set(
    file.currentLines
      .filter((line) => line.changeType === "added")
      .map((line) => line.line),
  );
  const deletions = new Set(file.deletedLines.map((line) => line.baselineLine));
  if (deletions.size !== file.deletedLines.length) {
    return false;
  }
  const hunkAdditions = new Set<number>();
  const hunkDeletions = new Set<number>();
  for (const hunk of file.hunks) {
    if (
      !addRange(hunkAdditions, hunk.newStart, hunk.newCount) ||
      !addRange(hunkDeletions, hunk.oldStart, hunk.oldCount)
    ) {
      return false;
    }
  }
  return (
    sameValues(additions, hunkAdditions) && sameValues(deletions, hunkDeletions)
  );
}
function decisionMatches(
  status: ReviewStatus,
  lastReviewer: LastReviewer | undefined,
  unchanged: boolean,
): boolean {
  if (unchanged) {
    return status === "reviewed" && lastReviewer === undefined;
  }
  if (status === "pending") {
    return lastReviewer === undefined;
  }
  return lastReviewer !== undefined;
}
function addRange(lines: Set<number>, start: number, count: number): boolean {
  for (let line = start; line < start + count; line += 1) {
    if (lines.has(line)) {
      return false;
    }
    lines.add(line);
  }
  return true;
}
function sameValues(
  left: ReadonlySet<number>,
  right: ReadonlySet<number>,
): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

