export type RevExtMarkerStyle = "line";

export interface RevExtMarkerMatch {
  readonly start: number;
  readonly style: RevExtMarkerStyle;
  readonly id: number;
}

const lineCommentTokens = new Map<string, string>([
  ["javascript", "//"],
  ["javascriptreact", "//"],
  ["typescript", "//"],
  ["typescriptreact", "//"],
  ["java", "//"],
  ["c", "//"],
  ["cpp", "//"],
  ["csharp", "//"],
  ["go", "//"],
  ["rust", "//"],
  ["swift", "//"],
  ["kotlin", "//"],
  ["scala", "//"],
  ["dart", "//"],
  ["php", "//"],
  ["fsharp", "//"],
  ["groovy", "//"],
  ["objective-c", "//"],
  ["objective-cpp", "//"],
  ["solidity", "//"],
  ["python", "#"],
  ["ruby", "#"],
  ["shellscript", "#"],
  ["powershell", "#"],
  ["r", "#"],
  ["julia", "#"],
  ["perl", "#"],
  ["elixir", "#"],
  ["sql", "--"],
  ["lua", "--"],
  ["haskell", "--"],
  ["erlang", "%"],
  ["clojure", ";"],
  ["lisp", ";"],
  ["scheme", ";"],
  ["vb", "'"],
  ["asm", ";"],
  ["assembly", ";"],
]);

const legacyReactLanguages = new Set(["javascriptreact", "typescriptreact"]);
const markerExpressions = new Map<string, RegExp>();

export function supportsRevExt(languageId: string): boolean {
  return lineCommentTokens.has(languageId);
}

export function markerStyles(
  lines: readonly string[],
  languageId: string,
): readonly (RevExtMarkerStyle | undefined)[] {
  const style: RevExtMarkerStyle | undefined = supportsRevExt(languageId)
    ? "line"
    : undefined;
  return lines.map(() => style);
}

export function markerSuffix(
  line: string,
  languageId: string,
  style: RevExtMarkerStyle,
  id: number,
): string {
  if (style !== "line") {
    return "";
  }
  const token = lineCommentTokens.get(languageId);
  if (token === undefined) {
    return "";
  }
  const leading = line.length === 0 ? "" : "  ";
  return `${leading}${token} RevExt: ${id}`;
}

export function findRevExtMarker(
  line: string,
  languageId: string,
): RevExtMarkerMatch | undefined {
  const token = lineCommentTokens.get(languageId);
  if (token !== undefined) {
    const lineMatch = markerExpression(token).exec(line);
    if (lineMatch !== null) {
      return {
        start: lineMatch.index,
        style: "line",
        id: Number(lineMatch[1] ?? lineMatch[2]),
      };
    }
  }
  if (legacyReactLanguages.has(languageId)) {
    const legacyMatch = legacyJsxMarkerExpression().exec(line);
    if (legacyMatch !== null) {
      return {
        start: legacyMatch.index,
        style: "line",
        id: Number(legacyMatch[1] ?? legacyMatch[2]),
      };
    }
  }
  return undefined;
}

export function stripRevExtMarker(line: string, languageId: string): string {
  const marker = findRevExtMarker(line, languageId);
  return marker === undefined ? line : line.slice(0, marker.start);
}

function markerExpression(token: string): RegExp {
  const cached = markerExpressions.get(token);
  if (cached !== undefined) {
    return cached;
  }
  const expression = new RegExp(
    `(?:\\s{2}${escape(token)}\\s+RevExt: ([1-9]\\d*)$|^\\s*${escape(token)}\\s+RevExt: ([1-9]\\d*)$)`,
  );
  markerExpressions.set(token, expression);
  return expression;
}

/** Recognize markers emitted by versions that used JSX expression comments. */
function legacyJsxMarkerExpression(): RegExp {
  const cached = markerExpressions.get("legacy-jsx");
  if (cached !== undefined) {
    return cached;
  }
  const expression = /(?:\s{2}\{\/\*\s+RevExt: ([1-9]\d*)\s+\*\/\}$|^\s*\{\/\*\s+RevExt: ([1-9]\d*)\s+\*\/\}$)/;
  markerExpressions.set("legacy-jsx", expression);
  return expression;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
