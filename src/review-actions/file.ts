import type * as vscode from "vscode";
import { reviewableLines, type Reviewer, type ReviewStatus } from "../domain";
import type { ReviewActionContext } from "./context";
import { withFreshFile } from "./shared";

export async function markFile(
  context: ReviewActionContext,
  source: vscode.Uri,
  status: ReviewStatus,
  reviewer?: Reviewer,
): Promise<boolean> {
  return withFreshFile(context, source, undefined, (file) => {
    if (status === "pending" && reviewableLines(file).length === 0) {
      return context.initializePendingFile(source);
    }
    return context.applyReview(
      source,
      file,
      status,
      reviewer,
      (line) => line.changeType !== "unchanged",
      () => true,
    );
  });
}
