import * as vscode from "vscode";
import { terminalPayload, type ReviewStatus, type Reviewer } from "./domain";
import { GitIgnoreService } from "./git-ignore";
import { ReviewService } from "./review-service";
import { ReviewerResolver } from "./reviewer";
import { eligibleWorkspacePaths } from "./workspace-discovery";
import { errorMessage } from "./extension-utils";

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
  if (document.uri.scheme !== "file") {
    return Promise.resolve();
  }
  const key = document.uri.toString();
  const previous = openingDocuments.get(key);
  if (previous !== undefined) {
    return previous;
  }
  const operation = openDocumentInReviewViewImpl(service, document);
  const current = operation.then(
    () => {
      if (openingDocuments.get(key) === current) {
        openingDocuments.delete(key);
      }
    },
    (error: unknown) => {
      if (openingDocuments.get(key) === current) {
        openingDocuments.delete(key);
      }
      throw error;
    },
  );
  openingDocuments.set(key, current);
  return current;
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

async function reviewer(
  resolver: ReviewerResolver,
  uri: vscode.Uri | undefined,
): Promise<Reviewer | undefined> {
  const folder =
    uri === undefined ? undefined : vscode.workspace.getWorkspaceFolder(uri);
  const workspaceKey = folder?.uri.toString() ?? "global";
  const directory = folder?.uri.fsPath;
  return resolver.resolve(workspaceKey, directory, async () => {
    return configuredReviewer(uri);
  });
}

async function configuredReviewer(
  uri: vscode.Uri | undefined,
): Promise<Reviewer | undefined> {
  const config = vscode.workspace.getConfiguration("codeReviewTracker", uri);
  const configuredName = config.get<string>("reviewerName", "").trim();
  const configuredEmail = config.get<string>("reviewerEmail", "").trim();
  let name = configuredName;
  let email = configuredEmail;
  if (name.length === 0) {
    name = (await vscode.window.showInputBox({
      prompt: "Reviewer name",
      ignoreFocusOut: true,
    }))?.trim() ?? "";
  }
  if (name.length === 0) {
    return undefined;
  }
  if (email.length === 0) {
    email = (await vscode.window.showInputBox({
      prompt: "Reviewer email (optional)",
      ignoreFocusOut: true,
    }))?.trim() ?? "";
  }
  if (configuredName.length === 0) {
    await config.update(
      "reviewerName",
      name,
      vscode.ConfigurationTarget.Global,
    );
  }
  if (email.length > 0 && configuredEmail.length === 0) {
    await config.update(
      "reviewerEmail",
      email,
      vscode.ConfigurationTarget.Global,
    );
  }
  return email.length > 0 ? { name, email } : { name };
}

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
      : await reviewer(reviewerResolver, source);
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
    status === "pending" ? undefined : await reviewer(reviewerResolver, uri);
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
    status === "pending" ? undefined : await reviewer(reviewerResolver, uri);
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
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    terminal =
      folder === undefined
        ? vscode.window.createTerminal({ name: "Code Review Agent" })
        : vscode.window.createTerminal({
            name: "Code Review Agent",
            cwd: folder.uri,
          });
    terminal.show(true);
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
