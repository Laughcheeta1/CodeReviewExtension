import {
  findRevExtMarker,
  markerStyles,
  markerSuffix,
  migrationEdits,
  stripRevExtMarker,
  supportsRevExt,
  type RevExtMigrationEdit,
} from "./revext-syntax";

export interface RevExtEdit {
  readonly line: number;
  readonly suffix: string;
}

export interface RevExtRemoval {
  readonly line: number;
  readonly start: number;
}

export type { RevExtMarkerStyle, RevExtMigrationEdit } from "./revext-syntax";

export function revExtEdits(
  lines: readonly string[],
  addedLines: ReadonlySet<number>,
  languageId: string,
  nextId: number,
): {
  readonly edits: readonly RevExtEdit[];
  readonly nextId: number;
} {
  if (!supportsRevExt(languageId)) {
    return { edits: [], nextId };
  }
  const styles = markerStyles(lines, languageId);
  const groups = new Map<string, number[]>();
  for (const line of addedLines) {
    const text = lines[line - 1];
    if (text === undefined) {
      continue;
    }
    const key = stripRevExtMarker(text, languageId);
    const matching = groups.get(key) ?? [];
    matching.push(line);
    groups.set(key, matching);
  }
  for (const line of addedLines) {
    const text = lines[line - 1];
    if (text === undefined) {
      continue;
    }
    const marker = findRevExtMarker(text, languageId);
    if (marker !== undefined) {
      nextId = Math.max(nextId, marker.id + 1);
    }
  }
  const edits: RevExtEdit[] = [];
  for (const matching of groups.values()) {
    if (matching.length < 2) {
      continue;
    }
    for (const line of matching) {
      const text = lines[line - 1]!;
      const style = styles[line - 1];
      if (
        findRevExtMarker(text, languageId) !== undefined ||
        style === undefined ||
        !safeForSuffix(text, languageId)
      ) {
        continue;
      }
      edits.push({
        line,
        suffix: markerSuffix(text, languageId, style, nextId),
      });
      nextId += 1;
    }
  }
  return { edits, nextId };
}

export function revExtRemovals(
  lines: readonly string[],
  addedLines: ReadonlySet<number>,
  languageId: string,
): readonly RevExtRemoval[] {
  if (!supportsRevExt(languageId)) {
    return [];
  }
  const result: RevExtRemoval[] = [];
  for (const line of addedLines) {
    const text = lines[line - 1];
    if (text === undefined) {
      continue;
    }
    const start = revExtMarkerStart(text, languageId);
    if (start !== undefined) {
      result.push({ line, start });
    }
  }
  return result;
}

/** Returns the character offset of a generated marker comment, if present. */
export function revExtMarkerStart(
  line: string,
  languageId: string,
): number | undefined {
  return findRevExtMarker(line, languageId)?.start;
}

/** Return legacy JSX line comments that can be converted without parsing again. */
export function revExtMigrationEdits(
  lines: readonly string[],
  languageId: string,
): readonly RevExtMigrationEdit[] {
  return migrationEdits(lines, languageId);
}

function safeForSuffix(line: string, languageId: string): boolean {
  if (line.endsWith("\\")) {
    return false;
  }
  if (languageId === "python" && /(?:'''|""")/.test(line)) {
    return false;
  }
  return true;
}
