import * as vscode from "vscode";
import { runLogged } from "../extension-utils";
import {
  closePromotedDiffTabs,
  openDocumentInReviewView,
} from "../review-commands";
import type { ReviewService } from "../review-service";
import type { ReviewDecorations } from "../ui";

function isReviewDiffDocument(uri: vscode.Uri): boolean {
  return vscode.window.tabGroups.all.some((group) =>
    group.tabs.some(
      (tab) =>
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.original.scheme === "code-review-baseline" &&
        tab.input.modified.toString() === uri.toString(),
    ),
  );
}

function isNormalTextDocumentTab(uri: vscode.Uri): boolean {
  return vscode.window.tabGroups.all.some((group) =>
    group.tabs.some(
      (tab) =>
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.toString() === uri.toString(),
    ),
  );
}

/** Wire saved-file, configuration, promotion, and visibility events. */
export function registerEventHandlers(
  context: vscode.ExtensionContext,
  service: ReviewService,
  log: vscode.LogOutputChannel,
  decorations: ReviewDecorations,
): void {
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (service.isInternalDocumentLoad(document.uri)) {
        return;
      }
      runLogged(
        log,
        "Document loading",
        openDocumentInReviewView(service, document),
      );
    }),
    vscode.workspace.onDidCloseTextDocument((document) =>
      service.forgetInternalDocumentLoad(document.uri),
    ),
    vscode.workspace.onDidSaveTextDocument((document) =>
      runLogged(
        log,
        "Saved-file reconciliation",
        service.reconcileSavedDocument(document),
      ),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration(
          "codeReviewTracker.ignoreEmptyLineDeletions",
        )
      ) {
        return;
      }
      runLogged(
        log,
        "Review policy refresh",
        service.refreshReviewPolicy(),
      );
    }),
    service.onDidPromote((source) =>
      runLogged(
        log,
        "Closing promoted diff tabs",
        closePromotedDiffTabs(source),
      ),
    ),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      decorations.refresh();
      setTimeout(() => {
        for (const editor of vscode.window.visibleTextEditors) {
          if (
            editor.document.uri.scheme !== "file" ||
            isReviewDiffDocument(editor.document.uri) ||
            !isNormalTextDocumentTab(editor.document.uri) ||
            !service.consumeInternalDocumentLoad(editor.document.uri)
          ) {
            continue;
          }
          runLogged(
            log,
            "Manually opened document",
            openDocumentInReviewView(service, editor.document),
          );
        }
      }, 0);
    }),
  );
}
