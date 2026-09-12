import * as vscode from "vscode";
import { serialized } from "../concurrency";
import { errorMessage } from "../extension-utils";
import {
  normalizeRepoFolder,
  normalizeRepoPath,
  REVIEW_EXTENSION_CONFIG_RELPATH,
} from "../revext-config";

type RevExtIgnoreKey =
  | "revExtIgnoredFiles"
  | "revExtIgnoredFolders"
  | "revExtIgnoredExtensions";

const configWrites = new Map<string, Promise<unknown>>();

/** Add the selected file to the shared RevExt ignore list. */
export async function ignoreFileForRevExt(
  uri?: vscode.Uri,
): Promise<void> {
  const target = resolveTargetUri(uri);
  if (target === undefined) {
    void vscode.window.showWarningMessage(
      "Open a workspace file or right-click a file to ignore it for RevExt comments.",
    );
    return;
  }
  const resolved = resolveWorkspaceRelative(target);
  if (resolved === undefined) {
    void vscode.window.showWarningMessage(
      "RevExt ignore entries are only supported for files inside the workspace.",
    );
    return;
  }
  const entry = normalizeRepoPath(resolved.relativePath);
  if (entry === undefined) {
    void vscode.window.showWarningMessage(
      "Could not determine a workspace-relative path for this file.",
    );
    return;
  }
  try {
    await addConfigEntry(resolved.folder, "revExtIgnoredFiles", entry);
    void vscode.window.showInformationMessage(
      `RevExt comments disabled for ${entry}; tracking continues. Shared via ${REVIEW_EXTENSION_CONFIG_RELPATH}.`,
    );
  } catch (error) {
    void vscode.window.showWarningMessage(errorMessage(error));
  }
}

/** Add the selected folder to the shared RevExt ignore list. */
export async function ignoreFolderForRevExt(
  uri?: vscode.Uri,
): Promise<void> {
  const target = resolveTargetUri(uri);
  if (target === undefined) {
    void vscode.window.showWarningMessage(
      "Right-click a folder to ignore it for RevExt comments.",
    );
    return;
  }
  const resolved = resolveWorkspaceRelative(target);
  if (resolved === undefined) {
    void vscode.window.showWarningMessage(
      "RevExt ignore entries are only supported for folders inside the workspace.",
    );
    return;
  }
  const folderEntry = await resolveFolderEntry(target, resolved.relativePath);
  const entry = normalizeRepoFolder(folderEntry);
  if (entry === undefined) {
    void vscode.window.showWarningMessage(
      "Could not determine a workspace-relative folder for this selection.",
    );
    return;
  }
  try {
    await addConfigEntry(resolved.folder, "revExtIgnoredFolders", entry);
    void vscode.window.showInformationMessage(
      `RevExt comments disabled under ${entry}/; tracking continues. Shared via ${REVIEW_EXTENSION_CONFIG_RELPATH}.`,
    );
  } catch (error) {
    void vscode.window.showWarningMessage(errorMessage(error));
  }
}

/** Add the selected file's extension to the shared RevExt ignore list. */
export async function ignoreExtensionForRevExt(
  uri?: vscode.Uri,
): Promise<void> {
  const target = resolveTargetUri(uri);
  if (target === undefined) {
    void vscode.window.showWarningMessage(
      "Open a workspace file or right-click a file to ignore its extension for RevExt comments.",
    );
    return;
  }
  if (vscode.workspace.getWorkspaceFolder(target) === undefined) {
    void vscode.window.showWarningMessage(
      "RevExt ignore entries are only supported for files inside the workspace.",
    );
    return;
  }
  const extension = finalExtensionWithDot(target.fsPath);
  if (extension === undefined) {
    void vscode.window.showWarningMessage(
      "This file has no extension to ignore.",
    );
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(target);
  if (folder === undefined) {
    void vscode.window.showWarningMessage(
      "RevExt ignore entries are only supported for files inside the workspace.",
    );
    return;
  }
  try {
    await addConfigEntry(folder, "revExtIgnoredExtensions", extension);
    void vscode.window.showInformationMessage(
      `RevExt comments disabled for ${extension} files; tracking continues. Shared via ${REVIEW_EXTENSION_CONFIG_RELPATH}.`,
    );
  } catch (error) {
    void vscode.window.showWarningMessage(errorMessage(error));
  }
}

function resolveTargetUri(uri?: vscode.Uri): vscode.Uri | undefined {
  if (uri !== undefined && uri.scheme === "file") {
    return uri;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active !== undefined && active.scheme === "file") {
    return active;
  }
  return undefined;
}

function resolveWorkspaceRelative(
  target: vscode.Uri,
): { folder: vscode.WorkspaceFolder; relativePath: string } | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(target);
  if (folder === undefined || folder.uri.scheme !== "file") {
    return undefined;
  }
  if (target.toString() === folder.uri.toString()) {
    return { folder, relativePath: "." };
  }
  const relativePath = vscode.workspace
    .asRelativePath(target, false)
    .replaceAll("\\", "/");
  if (relativePath.length === 0) {
    return undefined;
  }
  return { folder, relativePath };
}

async function resolveFolderEntry(
  target: vscode.Uri,
  relativePath: string,
): Promise<string> {
  try {
    const stat = await vscode.workspace.fs.stat(target);
    if (stat.type === vscode.FileType.Directory) {
      return relativePath;
    }
  } catch {
    // Fall through to parent-directory handling below.
  }
  const separator = relativePath.lastIndexOf("/");
  if (separator <= 0) {
    return ".";
  }
  return relativePath.slice(0, separator);
}

function finalExtensionWithDot(sourcePath: string): string | undefined {
  const separator = Math.max(
    sourcePath.lastIndexOf("/"),
    sourcePath.lastIndexOf("\\"),
  );
  const fileName = sourcePath.slice(separator + 1);
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) {
    return undefined;
  }
  const extension = fileName.slice(dot).trim().toLowerCase();
  if (extension.length <= 1) {
    return undefined;
  }
  return extension;
}

async function addConfigEntry(
  folder: vscode.WorkspaceFolder,
  key: RevExtIgnoreKey,
  entry: string,
): Promise<void> {
  const configUri = vscode.Uri.joinPath(
    folder.uri,
    ...REVIEW_EXTENSION_CONFIG_RELPATH.split("/"),
  );
  await serialized(configWrites, configUri.toString(), () =>
    writeConfigEntry(configUri, folder, key, entry),
  );
}

async function writeConfigEntry(
  configUri: vscode.Uri,
  folder: vscode.WorkspaceFolder,
  key: RevExtIgnoreKey,
  entry: string,
): Promise<void> {
  if (vscode.workspace.textDocuments.some((document) =>
    document.uri.toString() === configUri.toString() && document.isDirty,
  )) {
    throw new Error(`Save ${REVIEW_EXTENSION_CONFIG_RELPATH} before changing RevExt ignore entries.`);
  }
  const raw = await readConfigObject(configUri);
  const existing = Array.isArray(raw[key]) ? raw[key] : [];
  const normalizedEntry = key === "revExtIgnoredExtensions"
    ? entry.trim().toLowerCase()
    : entry;
  let alreadyPresent = false;
  for (const candidate of existing) {
    if (typeof candidate !== "string") {
      continue;
    }
    const normalizedCandidate = key === "revExtIgnoredExtensions"
      ? candidate.trim().toLowerCase()
      : candidate.trim();
    if (normalizedCandidate === normalizedEntry) {
      alreadyPresent = true;
      break;
    }
  }
  if (!alreadyPresent) {
    existing.push(entry);
  }
  raw[key] = existing;
  await vscode.workspace.fs.createDirectory(
    vscode.Uri.joinPath(folder.uri, ".vscode"),
  );
  const encoded = new TextEncoder().encode(`${JSON.stringify(raw, null, 2)}\n`);
  await vscode.workspace.fs.writeFile(configUri, encoded);
}

async function readConfigObject(
  configUri: vscode.Uri,
): Promise<Record<string, unknown>> {
  try {
    const bytes = await vscode.workspace.fs.readFile(configUri);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
      return {};
    }
    if (isEntryNotFound(error)) {
      return {};
    }
    throw error;
  }
  throw new Error(`${REVIEW_EXTENSION_CONFIG_RELPATH} must contain a JSON object. Existing content was preserved.`);
}

function isEntryNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as Record<string, unknown>;
  if (record["code"] === "FileNotFound" || record["code"] === "ENOENT") {
    return true;
  }
  const message = record["message"];
  if (typeof message === "string" && message.includes("ENOENT")) {
    return true;
  }
  return false;
}
