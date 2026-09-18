import type * as vscode from "vscode";
import { reviewStats, setReviewer } from "../domain/status";
import type {
  FileRecord,
  Reviewer,
  ReviewStatus,
} from "../domain/types";
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
  const stats = reviewStats(file);
  if (
    file.baseline.digest !== file.current.digest &&
    stats.total > 0 &&
    stats.reviewed === stats.total
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
  let changed = false;
  const currentLines = file.currentLines.map((line) => {
    if (!matchesCurrent(line)) {
      return line;
    }
    changed = true;
    return { ...line, reviewStatus: status, lastReviewer };
  });
  const deletedLines = file.deletedLines.map((line) => {
    if (!matchesDeleted(line)) {
      return line;
    }
    changed = true;
    return { ...line, reviewStatus: status, lastReviewer };
  });
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
