import * as vscode from "vscode";
import type { ReviewStatus } from "../domain";
import { errorMessage } from "../extension-utils";
import type { ReviewService } from "../review-service";
import type { ReviewerResolver } from "../reviewer";
import { resolveReviewer } from "./reviewer-flow";

export async function markActive(
  service: ReviewService,
  reviewerResolver: ReviewerResolver,
  status: ReviewStatus,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    return;
  }
  const source =
    service.parseBaselineUri(editor.document.uri)?.source ??
    editor.document.uri;
  await service.initializeSource(source);
  const identity =
    status === "pending"
      ? undefined
      : await resolveReviewer(reviewerResolver, source);
  if (status !== "pending" && identity === undefined) {
    return;
  }
  try {
    if (!(await service.markEditor(editor, status, identity))) {
      void vscode.window.showInformationMessage(
        "The selection contains no reviewable changes.",
      );
    }
  } catch (error) {
    void vscode.window.showWarningMessage(errorMessage(error));
  }
}

export async function markFile(
  service: ReviewService,
  reviewerResolver: ReviewerResolver,
  uri: vscode.Uri | undefined,
  status: ReviewStatus,
): Promise<void> {
  if (uri === undefined || uri.scheme !== "file") {
    return;
  }
  await service.initializeSource(uri);
  const identity =
    status === "pending" ? undefined : await resolveReviewer(reviewerResolver, uri);
  if (status !== "pending" && identity === undefined) {
    return;
  }
  try {
    if (!(await service.markFile(uri, status, identity))) {
      void vscode.window.showInformationMessage(
        "The file contains no reviewable changes.",
      );
    }
  } catch (error) {
    void vscode.window.showWarningMessage(errorMessage(error));
  }
}

export async function markFolder(
  service: ReviewService,
  reviewerResolver: ReviewerResolver,
  uri: vscode.Uri | undefined,
  status: ReviewStatus,
): Promise<void> {
  if (uri === undefined || uri.scheme !== "file") {
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder !== undefined) {
    await service.initializeDiscoveredSources(folder);
  }
  const identity =
    status === "pending" ? undefined : await resolveReviewer(reviewerResolver, uri);
  if (status !== "pending" && identity === undefined) {
    return;
  }
  try {
    const marked = await service.markFolder(uri, status, identity);
    if (marked === 0) {
      void vscode.window.showInformationMessage(
        "The folder contains no reviewable tracked files.",
      );
    }
  } catch (error) {
    void vscode.window.showWarningMessage(errorMessage(error));
  }
}
