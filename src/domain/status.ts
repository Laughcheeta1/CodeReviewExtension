import type {
  CurrentLineRecord,
  DeletedLineRecord,
  FileRecord,
  LastReviewer,
  Reviewer,
  ReviewStatus,
} from "./types";


export function reviewableLines(
  file: Pick<FileRecord, "currentLines" | "deletedLines">,
): readonly (CurrentLineRecord | DeletedLineRecord)[] {
  return [
    ...file.currentLines.filter((line) => line.changeType !== "unchanged"),
    ...file.deletedLines,
  ];
}

export function fileStatus(
  file: Pick<FileRecord, "currentLines" | "deletedLines">,
): ReviewStatus {
  const changed = reviewableLines(file);
  if (
    changed.length === 0 ||
    changed.every((line) => line.reviewStatus === "reviewed")
  ) {
    return "reviewed";
  }
  if (changed.some((line) => line.reviewStatus !== "pending")) {
    return "inReview";
  }
  return "pending";
}

export function reviewCounts(
  file: Pick<FileRecord, "currentLines" | "deletedLines">,
): {
  reviewed: number;
  total: number;
} {
  const changed = reviewableLines(file);
  return {
    reviewed: changed.filter((line) => line.reviewStatus === "reviewed").length,
    total: changed.length,
  };
}

export function setReviewer(
  status: ReviewStatus,
  reviewer: Reviewer | undefined,
  at: string,
): LastReviewer | undefined {
  if (status === "pending") {
    return undefined;
  }
  if (reviewer === undefined) {
    throw new Error("A reviewer is required for non-pending decisions");
  }
  return reviewer.email === undefined
    ? { name: reviewer.name, time: at }
    : { name: reviewer.name, email: reviewer.email, time: at };
}
