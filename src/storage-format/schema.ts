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

