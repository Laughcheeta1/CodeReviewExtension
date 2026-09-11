import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Uri } from "vscode";

/** Setting key within the `codeReviewTracker` configuration section. */
export const REVEXT_DISABLED_EXTENSIONS_SETTING =
  "revExtDisabledExtensions";

/** Workspace-relative path of the shared, repo-committable RevExt config. */
export const REVIEW_EXTENSION_CONFIG_RELPATH =
  ".vscode/review-extension.json";

/** Repo-shared RevExt opt-out lists. Paths are workspace-relative posix paths. */
export interface RevExtWorkspaceConfig {
  readonly files: readonly string[];
  readonly folders: readonly string[];
  readonly extensions: readonly string[];
}

/** Empty workspace config used when the shared file is missing or invalid. */
export const EMPTY_REVEXT_WORKSPACE_CONFIG: RevExtWorkspaceConfig = {
  files: [],
  folders: [],
  extensions: [],
};

/**
 * Returns whether RevExt identity comments are disabled for a source path.
 * Entries may be written as `ts` or `.ts` and are matched case-insensitively
 * against the final extension of the source file.
 */
export function isRevExtDisabled(
  uriOrPath: Uri | string,
  disabledExtensions: readonly string[] | undefined,
): boolean {
  const extension = finalExtension(
    typeof uriOrPath === "string" ? uriOrPath : uriOrPath.fsPath,
  );
  if (extension === undefined || disabledExtensions === undefined) {
    return false;
  }
  return disabledExtensions.some(
    (candidate) => normalizeExtension(candidate) === extension,
  );
}

/**
 * Returns whether a workspace-relative posix path is ignored for RevExt
 * generation by the shared workspace config. Files still keep review
 * metadata; only automatic RevExt comment generation is skipped.
 */
export function isRevExtIgnoredByWorkspaceConfig(
  relativePath: string,
  config: RevExtWorkspaceConfig | undefined,
): boolean {
  if (config === undefined) {
    return false;
  }
  const normalizedPath = normalizeRepoPath(relativePath);
  if (normalizedPath === undefined) {
    return false;
  }
  for (const file of config.files) {
    if (file === normalizedPath) {
      return true;
    }
  }
  for (const folder of config.folders) {
    if (normalizedPath === folder || normalizedPath.startsWith(`${folder}/`)) {
      return true;
    }
  }
  if (config.extensions.length > 0) {
    const extension = finalExtension(normalizedPath);
    if (extension !== undefined) {
      for (const candidate of config.extensions) {
        if (candidate === extension) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Combines the per-user extension setting with the repo-shared workspace
 * config. Either source disables automatic RevExt generation.
 */
export function isRevExtDisabledWithWorkspaceConfig(
  uriOrPath: Uri | string,
  disabledExtensions: readonly string[] | undefined,
  relativePath: string | undefined,
  workspaceConfig: RevExtWorkspaceConfig | undefined,
): boolean {
  if (isRevExtDisabled(uriOrPath, disabledExtensions)) {
    return true;
  }
  if (relativePath !== undefined) {
    if (isRevExtIgnoredByWorkspaceConfig(relativePath, workspaceConfig)) {
      return true;
    }
  }
  return false;
}

/**
 * Parses untrusted JSON content of the shared config file into normalized
 * lists. Unknown shapes, non-string entries, and empty entries are ignored.
 * `revExtDisabledExtensions` is accepted as an alias for extensions.
 */
export function parseRevExtWorkspaceConfig(raw: unknown): RevExtWorkspaceConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { files: [], folders: [], extensions: [] };
  }
  const record = raw as Record<string, unknown>;
  const files = normalizeStringList(record["revExtIgnoredFiles"]).flatMap(
    (value) => {
      const normalized = normalizeRepoPath(value);
      if (normalized === undefined) {
        return [];
      }
      return [normalized];
    },
  );
  const folders = normalizeStringList(record["revExtIgnoredFolders"]).flatMap(
    (value) => {
      const normalized = normalizeRepoFolder(value);
      if (normalized === undefined) {
        return [];
      }
      return [normalized];
    },
  );
  const extensions = [
    ...normalizeStringList(record["revExtIgnoredExtensions"]),
    ...normalizeStringList(record["revExtDisabledExtensions"]),
  ].flatMap((value) => {
    const normalized = normalizeExtension(value);
    if (normalized === undefined) {
      return [];
    }
    return [normalized];
  });
  return {
    files: [...new Set(files)],
    folders: [...new Set(folders)],
    extensions: [...new Set(extensions)],
  };
}

/**
 * Reads and parses the shared config file for a workspace folder. Missing
 * files, unreadable files, and invalid JSON yield an empty config so RevExt
 * generation stays enabled rather than failing closed.
 */
export function loadRevExtWorkspaceConfigForFolderSync(
  folderFsPath: string,
): RevExtWorkspaceConfig {
  try {
    const raw = readFileSync(
      join(folderFsPath, ...REVIEW_EXTENSION_CONFIG_RELPATH.split("/")),
      "utf8",
    );
    return parseRevExtWorkspaceConfig(JSON.parse(raw));
  } catch {
    return { files: [], folders: [], extensions: [] };
  }
}

/** Normalizes a workspace-relative file path to a posix form. */
export function normalizeRepoPath(value: string): string | undefined {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (trimmed.length === 0) {
    return undefined;
  }
  let normalized = trimmed;
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  while (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  normalized = normalized.replaceAll(/\/+/g, "/");
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized === "." || normalized === "./") {
    return undefined;
  }
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.length === 0 || normalized === ".") {
    return undefined;
  }
  return normalized;
}

/** Normalizes a workspace-relative folder entry to a prefix-matchable form. */
export function normalizeRepoFolder(value: string): string | undefined {
  const normalized = normalizeRepoPath(value);
  if (normalized === undefined) {
    return undefined;
  }
  return normalized;
}

function normalizeStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        result.push(entry);
      }
    }
  }
  return result;
}

function finalExtension(sourcePath: string): string | undefined {
  const separator = Math.max(
    sourcePath.lastIndexOf("/"),
    sourcePath.lastIndexOf("\\"),
  );
  const fileName = sourcePath.slice(separator + 1);
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) {
    return undefined;
  }
  return normalizeExtension(fileName.slice(dot + 1));
}

function normalizeExtension(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  const normalized = trimmed.startsWith(".")
    ? trimmed.slice(1)
    : trimmed;
  return normalized.length === 0 ? undefined : normalized;
}
