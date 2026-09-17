import * as vscode from "vscode";
import { coalesced } from "../concurrency";
import { errorMessage } from "../extension-utils";
import type { ReviewService } from "../review-service";

const openingDocuments = new Map<string, Promise<void>>();

export async function openReviewDiff(
  service: ReviewService,
  uri?: vscode.Uri,
): Promise<void> {
  const requested = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (requested === undefined) {
    return;
  }
  const source = service.parseBaselineUri(requested)?.source ?? requested;
  try {
    const prepared = await service.prepareDiff(source);
    if (prepared === undefined) {
      void vscode.window.showInformationMessage(
        "Initialize this workspace before opening review diffs.",
      );
      return;
    }
    if (prepared.file.hunks.length === 0) {
      await vscode.window.showTextDocument(source);
      return;
    }
    const path = service.relativePath(source) ?? source.path;
    await vscode.commands.executeCommand(
      "vscode.diff",
      prepared.baseline,
      source,
      `Code Review: ${path}`,
    );
  } catch (error) {
    void vscode.window.showWarningMessage(errorMessage(error));
  }
}

export function openDocumentInReviewView(
  service: ReviewService,
  document: vscode.TextDocument,
): Promise<void> {
  const key = document.uri.toString();
  return coalesced(openingDocuments, key, () =>
    openDocumentInReviewViewImpl(service, document),
  );
}

async function openDocumentInReviewViewImpl(
  service: ReviewService,
  document: vscode.TextDocument,
): Promise<void> {
  await service.initializeOpenedDocument(document);
  await service.ensureDocument(document);
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const openInReviewView = vscode.workspace
    .getConfiguration("codeReviewTracker", document.uri)
    .get<boolean>("openFilesInReviewView", true);
  if (
    document.uri.scheme !== "file" ||
    folder === undefined ||
    service.initializationState(folder) !== "initialized" ||
    !openInReviewView
  ) {
    return;
  }
  await openReviewDiff(service, document.uri);
}

export async function closePromotedDiffTabs(source: vscode.Uri): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    const stale = group.tabs.filter(
      (tab) =>
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.original.scheme === "code-review-baseline" &&
        tab.input.modified.toString() === source.toString(),
    );
    if (stale.length > 0) {
      await vscode.window.tabGroups.close(stale, true);
    }
  }
}
