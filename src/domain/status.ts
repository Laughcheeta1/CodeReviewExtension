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

export interface ReviewStats {
  readonly total: number;
  readonly reviewed: number;
  readonly hasNonPending: boolean;
}

export function reviewStats(
  file: Pick<FileRecord, "currentLines" | "deletedLines">,
): ReviewStats {
  let total = 0;
  let reviewed = 0;
  let hasNonPending = false;
  for (const line of file.currentLines) {
    if (line.changeType === "unchanged") {
      continue;
    }
    total += 1;
    if (line.reviewStatus === "reviewed") {
      reviewed += 1;
    }
    if (line.reviewStatus !== "pending") {
      hasNonPending = true;
    }
  }
  for (const line of file.deletedLines) {
    total += 1;
    if (line.reviewStatus === "reviewed") {
      reviewed += 1;
    }
    if (line.reviewStatus !== "pending") {
      hasNonPending = true;
    }
  }
  return { total, reviewed, hasNonPending };
}

export function fileStatus(
  file: Pick<FileRecord, "currentLines" | "deletedLines">,
): ReviewStatus {
  const stats = reviewStats(file);
  if (stats.total === 0 || stats.reviewed === stats.total) {
    return "reviewed";
  }
  if (stats.hasNonPending) {
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
  const stats = reviewStats(file);
  return {
    reviewed: stats.reviewed,
    total: stats.total,
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
