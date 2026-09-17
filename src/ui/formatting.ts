import * as vscode from "vscode";
import type { ReviewStatus } from "../domain";

export const statusText: Record<ReviewStatus, string> = {
  pending: "Pending review",
  inReview: "In review",
  reviewed: "Reviewed",
};

export const statusIcon: Record<ReviewStatus, string> = {
  pending: "P",
  inReview: "●",
  reviewed: "✓",
};

export function lineDecoration(
  line: number,
  change: string,
  status: ReviewStatus,
  lastReviewer:
    | {
        name: string;
        time: string;
      }
    | undefined,
): vscode.DecorationOptions {
  const hoverMessage = new vscode.MarkdownString();
  hoverMessage.appendText(`${change}: ${statusText[status]}`);
  if (lastReviewer !== undefined) {
    hoverMessage.appendText(` by ${lastReviewer.name} on ${lastReviewer.time}`);
  }
  return { range: new vscode.Range(line - 1, 0, line - 1, 0), hoverMessage };
}

export function gutterIcon(color: string): vscode.Uri {
  return vscode.Uri.parse(
    `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5" fill="#${color}"/></svg>`)}`,
  );
}
