import * as vscode from "vscode";
import { terminalPayload } from "../domain";
import { errorMessage } from "../extension-utils";
import type { GitIgnoreService } from "../git-ignore";
import type { ReviewService } from "../review-service";
import { eligibleWorkspacePaths } from "../workspace-discovery";

export async function initializeAll(
  service: ReviewService,
  ignoreRules: GitIgnoreService,
  status: "pending" | "reviewed",
): Promise<void> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    let paths: readonly string[];
    try {
      paths = await eligibleWorkspacePaths(folder, ignoreRules);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Ignore rules could not be evaluated for ${folder.name}. Tracking was not initialized. ${errorMessage(error)}`,
      );
      continue;
    }
    try {
      await service.initializeFolder(
        folder,
        status,
        [{ kind: "folder", path: "" }],
        paths,
      );
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
    }
  }
}

export function sendSelection(service: ReviewService): void {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== "file") {
    return;
  }
  const path = service.relativePath(editor.document.uri);
  if (path === undefined) {
    return;
  }
  const payload = terminalPayload(
    path,
    editor.document.getText(),
    selectionRanges(editor),
  );
  let terminal = vscode.window.activeTerminal;
  if (terminal === undefined) {
    terminal = createAgentTerminal(editor.document.uri);
    const command = vscode.workspace
      .getConfiguration("codeReviewTracker")
      .get<string>("agentCommand", "")
      .trim();
    if (command.length > 0 && vscode.workspace.isTrusted) {
      terminal.sendText(command, true);
    }
  }
  terminal.sendText(payload, false);
}

function createAgentTerminal(source: vscode.Uri): vscode.Terminal {
  const folder = vscode.workspace.getWorkspaceFolder(source);
  const terminal =
    folder === undefined
      ? vscode.window.createTerminal({ name: "Code Review Agent" })
      : vscode.window.createTerminal({
          name: "Code Review Agent",
          cwd: folder.uri,
        });
  terminal.show(true);
  return terminal;
}

function selectionRanges(editor: vscode.TextEditor): readonly {
  start: number;
  end: number;
}[] {
  const unique = new Map<string, { start: number; end: number }>();
  for (const selection of editor.selections) {
    const start = selection.isEmpty
      ? selection.active.line
      : selection.start.line;
    const end = selection.isEmpty
      ? start
      : selection.end.line + (selection.end.character > 0 ? 1 : 0);
    unique.set(`${start}:${end}`, { start, end });
  }
  return [...unique.values()].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
}
