import type * as vscode from "vscode";
import type { Reviewer, ReviewStatus } from "../domain";
import { selectedLines } from "../review-service-utils";
import type { ReviewActionContext } from "./context";
import { withFreshFile } from "./shared";

export async function markEditor(
  context: ReviewActionContext,
  editor: vscode.TextEditor,
  status: ReviewStatus,
  reviewer?: Reviewer,
): Promise<boolean> {
  const identity = context.parseBaselineUri(editor.document.uri);
  const source = identity?.source ?? editor.document.uri;
  const selected = selectedLines(editor.selections);
  return withFreshFile(context, source, identity, (file) =>
    context.applyReview(
      source,
      file,
      status,
      reviewer,
      (line) =>
        identity === undefined &&
        line.changeType !== "unchanged" &&
        selected.has(line.line),
      (line) => identity !== undefined && selected.has(line.baselineLine),
    ),
  );
}
