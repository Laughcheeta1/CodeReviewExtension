import type { ReviewStatus } from "./domain/types";

export function folderProgressMessage(
  marked: number,
  total: number,
  status: ReviewStatus,
): string {
  const statusLabel = status === "inReview" ? "in review" : status;
  return `${marked}/${total} files successfully set to ${statusLabel}`;
}
