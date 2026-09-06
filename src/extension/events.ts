import * as vscode from "vscode";
import { runLogged } from "../extension-utils";
import {
  closePromotedDiffTabs,
  openDocumentInReviewView,
} from "../review-commands";
import type { ReviewService } from "../review-service";
import type { ReviewDecorations } from "../ui";

function collectTabState(): {
  readonly normalTextUris: ReadonlySet<string>;
  readonly reviewDiffModifiedUris: ReadonlySet<string>;
} {
  const normalTextUris = new Set<string>();
  const reviewDiffModifiedUris = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTextDiff) {
        if (tab.input.original.scheme === "code-review-baseline") {
          reviewDiffModifiedUris.add(tab.input.modified.toString());
        }
      } else if (tab.input instanceof vscode.TabInputText) {
        normalTextUris.add(tab.input.uri.toString());
      }
    }
  }
  return { normalTextUris, reviewDiffModifiedUris };
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
        const { normalTextUris, reviewDiffModifiedUris } = collectTabState();
        for (const editor of vscode.window.visibleTextEditors) {
          const key = editor.document.uri.toString();
          if (
            editor.document.uri.scheme !== "file" ||
            reviewDiffModifiedUris.has(key) ||
            !normalTextUris.has(key) ||
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
