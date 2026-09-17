import * as vscode from "vscode";
import { physicalLines, type RawGitHunk } from "./domain";

export { isFileNotFound } from "./errors";

export const now = (): string => new Date().toISOString();

export function initialAdditionHunks(
  bytes: Uint8Array,
): readonly RawGitHunk[] {
  const count = physicalLines(bytes).length;
  return count === 0
    ? []
    : [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: count }];
}

export function progressIncrement(total: number): number {
  return total === 0 ? 0 : 100 / total;
}

export function selectedLines(
  selections: readonly vscode.Selection[],
): ReadonlySet<number> {
  const result = new Set<number>();
  for (const selection of selections) {
    const start = selection.start.line;
    const end =
      selection.end.line -
      (!selection.isEmpty && selection.end.character === 0 ? 1 : 0);
    for (let line = start; line <= Math.max(start, end); line += 1) {
      result.add(line + 1);
    }
  }
  return result;
}

export function isExcludedPath(path: string): boolean {
  return (
    path === ".git" ||
    path.startsWith(".git/") ||
    path === "node_modules" ||
    path.startsWith("node_modules/") ||
    path === ".vscode-test" ||
    path.startsWith(".vscode-test/") ||
    path === ".vscode/code-review-tracker" ||
    path.startsWith(".vscode/code-review-tracker/")
  );
}
