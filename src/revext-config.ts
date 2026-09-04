import type { Uri } from "vscode";

/** Setting key within the `codeReviewTracker` configuration section. */
export const REVEXT_DISABLED_EXTENSIONS_SETTING =
  "revExtDisabledExtensions";

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
