import type * as vscode from "vscode";
import {
  reviewableLines,
  setReviewer,
  type FileRecord,
  type Reviewer,
  type ReviewStatus,
} from "../domain";
import { now } from "../review-service-utils";
import type { ReviewMutationContext } from "./context";
import { promote } from "./promote";

export async function commitReview(
  context: ReviewMutationContext,
  source: vscode.Uri,
  file: FileRecord,
): Promise<void> {
  const path = context.relativePath(source);
  const store = context.storeFor(source);
  if (path === undefined || store === undefined) {
    return;
  }
  if (!(await context.isEligibleSource(source))) {
    throw new Error("Ignored files cannot be tracked for review.");
  }
  await store.commit(path, file);
  const changes = reviewableLines(file);
  if (
    file.baseline.digest !== file.current.digest &&
    changes.length > 0 &&
    changes.every((line) => line.reviewStatus === "reviewed")
  ) {
    await promote(context, source, file);
    return;
  }
  context.changedEmitter.fire(source);
}

export async function applyReview(
  context: ReviewMutationContext,
  source: vscode.Uri,
  file: FileRecord,
  status: ReviewStatus,
  reviewer: Reviewer | undefined,
  matchesCurrent: (line: FileRecord["currentLines"][number]) => boolean,
  matchesDeleted: (line: FileRecord["deletedLines"][number]) => boolean,
): Promise<boolean> {
  const at = now();
  const lastReviewer = setReviewer(status, reviewer, at);
  const currentLines = file.currentLines.map((line) =>
    matchesCurrent(line)
      ? { ...line, reviewStatus: status, lastReviewer }
      : line,
  );
  const deletedLines = file.deletedLines.map((line) =>
    matchesDeleted(line)
      ? { ...line, reviewStatus: status, lastReviewer }
      : line,
  );
  const changed =
    currentLines.some((line, index) => line !== file.currentLines[index]) ||
    deletedLines.some((line, index) => line !== file.deletedLines[index]);
  if (!changed) {
    return false;
  }
  await commitReview(context, source, {
    ...file,
    currentLines,
    deletedLines,
    lastReviewTime: at,
    updatedAt: at,
  });
  return true;
}
