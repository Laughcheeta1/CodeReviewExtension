export type RevExtMarkerStyle = "line" | "jsx";

export interface RevExtMarkerMatch {
  readonly start: number;
  readonly style: RevExtMarkerStyle;
  readonly id: number;
}

export interface RevExtMigrationEdit {
  readonly line: number;
  readonly start: number;
  readonly replacement: string;
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

const reactLanguages = new Set(["javascriptreact", "typescriptreact"]);

const markerExpressions = new Map<string, RegExp>();

export function supportsRevExt(languageId: string): boolean {
  return lineCommentTokens.has(languageId);
}

export function markerStyles(
  lines: readonly string[],
  languageId: string,
): readonly (RevExtMarkerStyle | undefined)[] {
  if (!supportsRevExt(languageId)) {
    return lines.map(() => undefined);
  }
  if (!reactLanguages.has(languageId)) {
    return lines.map(() => "line");
  }
  return reactMarkerStyles(lines);
}

export function markerSuffix(
  line: string,
  languageId: string,
  style: RevExtMarkerStyle,
  id: number,
): string {
  const leading = line.length === 0 ? "" : "  ";
  if (style === "jsx") {
    return `${leading}{/* RevExt: ${id} */}`;
  }
  const token = lineCommentTokens.get(languageId);
  if (token === undefined) {
    return "";
  }
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
  if (reactLanguages.has(languageId)) {
    const jsxMatch = jsxMarkerExpression().exec(line);
    if (jsxMatch !== null) {
      return {
        start: jsxMatch.index,
        style: "jsx",
        id: Number(jsxMatch[1] ?? jsxMatch[2]),
      };
    }
  }
  return undefined;
}

export function stripRevExtMarker(line: string, languageId: string): string {
  const marker = findRevExtMarker(line, languageId);
  return marker === undefined ? line : line.slice(0, marker.start);
}

export function migrationEdits(
  lines: readonly string[],
  languageId: string,
): readonly RevExtMigrationEdit[] {
  if (!reactLanguages.has(languageId)) {
    return [];
  }
  const styles = markerStyles(lines, languageId);
  const result: RevExtMigrationEdit[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const marker = findRevExtMarker(line, languageId);
    if (marker === undefined) {
      continue;
    }
    const separator = line.slice(marker.start).startsWith("  ") ? "  " : "";
    if (marker.style === "line" && styles[index] === "jsx") {
      result.push({
        line: index + 1,
        start: marker.start,
        replacement: `${separator}{/* RevExt: ${marker.id} */}`,
        id: marker.id,
      });
    }
  }
  return result;
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

function jsxMarkerExpression(): RegExp {
  const cached = markerExpressions.get("jsx");
  if (cached !== undefined) {
    return cached;
  }
  const expression = /(?:\s{2}\{\/\*\s+RevExt: ([1-9]\d*)\s+\*\/\}$|^\s*\{\/\*\s+RevExt: ([1-9]\d*)\s+\*\/\}$)/;
  markerExpressions.set("jsx", expression);
  return expression;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface JsMode {
  readonly kind: "js";
  braces: number;
  lexical: JsLexical | undefined;
  readonly returnMode: ScanMode | undefined;
}

interface JsxTextMode {
  readonly kind: "jsx-text";
  readonly returnMode: ScanMode;
}

interface JsxTagMode {
  readonly kind: "jsx-tag";
  readonly returnMode: ScanMode;
  readonly closing: boolean;
  quote: string | undefined;
}

type ScanMode = JsMode | JsxTextMode | JsxTagMode;

type JsLexical =
  | { kind: "line-comment" }
  | { kind: "block-comment" }
  | { kind: "quote"; quote: string; escaped: boolean }
  | { kind: "regex"; escaped: boolean; characterClass: boolean };

function reactMarkerStyles(
  lines: readonly string[],
): readonly (RevExtMarkerStyle | undefined)[] {
  if (lines.length === 0) {
    return [];
  }
  const source = lines.join("\n");
  const result: (RevExtMarkerStyle | undefined)[] = [];
  let mode: ScanMode = {
    kind: "js",
    braces: 0,
    lexical: undefined,
    returnMode: undefined,
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\n") {
      result.push(styleAtLineEnd(mode));
      resetLineComment(mode);
      continue;
    }
    if (mode.kind === "jsx-text") {
      if (character === "{") {
        mode = jsExpression(mode);
        continue;
      }
      if (character === "<") {
        const next = source[index + 1];
        if (next === "/" || next === ">" || isJsxTagStart(next)) {
          mode = {
            kind: "jsx-tag",
            returnMode: mode,
            closing: next === "/",
            quote: undefined,
          };
          if (next === "/") {
            index += 1;
          }
        }
      }
      continue;
    }
    if (mode.kind === "jsx-tag") {
      if (mode.quote !== undefined) {
        if (character === "\\") {
          index += 1;
        } else if (character === mode.quote) {
          mode.quote = undefined;
        }
        continue;
      }
      if (character === "\"" || character === "'") {
        mode.quote = character;
        continue;
      }
      if (character === "{") {
        mode = jsExpression(mode);
        continue;
      }
      if (character === ">") {
        const selfClosing: boolean =
          mode.closing || isSelfClosingTag(source, index);
        if (selfClosing) {
          mode = mode.closing
            ? afterJsxClosingTag(mode.returnMode)
            : mode.returnMode;
        } else {
          mode = {
            kind: "jsx-text",
            returnMode: mode.returnMode,
          };
        }
      }
      continue;
    }
    const lexical = mode.lexical;
    if (lexical?.kind === "line-comment") {
      continue;
    }
    if (lexical?.kind === "block-comment") {
      if (character === "*" && source[index + 1] === "/") {
        mode.lexical = undefined;
        index += 1;
      }
      continue;
    }
    if (lexical?.kind === "quote") {
      if (lexical.escaped) {
        lexical.escaped = false;
      } else if (character === "\\") {
        lexical.escaped = true;
      } else if (character === lexical.quote) {
        mode.lexical = undefined;
      }
      continue;
    }
    if (lexical?.kind === "regex") {
      if (lexical.escaped) {
        lexical.escaped = false;
      } else if (character === "\\") {
        lexical.escaped = true;
      } else if (character === "[") {
        lexical.characterClass = true;
      } else if (character === "]") {
        lexical.characterClass = false;
      } else if (character === "/" && !lexical.characterClass) {
        mode.lexical = undefined;
      }
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      mode.lexical = { kind: "line-comment" };
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      mode.lexical = { kind: "block-comment" };
      index += 1;
      continue;
    }
    if (
      character === "/" &&
      source[index + 1] !== undefined &&
      isLikelyRegexStart(source, index)
    ) {
      mode.lexical = {
        kind: "regex",
        escaped: false,
        characterClass: false,
      };
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      mode.lexical = { kind: "quote", quote: character, escaped: false };
      continue;
    }
    if (character === "{") {
      mode.braces += 1;
      continue;
    }
    if (character === "}") {
      if (mode.braces > 0) {
        mode.braces -= 1;
        if (mode.braces === 0 && mode.returnMode !== undefined) {
          mode = mode.returnMode;
        }
      }
      continue;
    }
    if (
      character === "<" &&
      isLikelyJsxStart(source, index)
    ) {
      mode = {
        kind: "jsx-tag",
        returnMode: mode,
        closing: false,
        quote: undefined,
      };
    }
  }
  result.push(styleAtLineEnd(mode));
  while (result.length < lines.length) {
    result.push(undefined);
  }
  return result;
}

function jsExpression(returnMode: ScanMode): JsMode {
  return {
    kind: "js",
    braces: 1,
    lexical: undefined,
    returnMode,
  };
}

function afterJsxClosingTag(returnMode: ScanMode): ScanMode {
  if (
    returnMode.kind === "jsx-text" &&
    returnMode.returnMode.kind === "js"
  ) {
    return returnMode.returnMode;
  }
  return returnMode;
}

function resetLineComment(mode: ScanMode): void {
  if (mode.kind === "js" && mode.lexical?.kind === "line-comment") {
    mode.lexical = undefined;
  }
}

function styleAtLineEnd(
  mode: ScanMode,
): RevExtMarkerStyle | undefined {
  if (mode.kind === "jsx-text") {
    return "jsx";
  }
  if (mode.kind === "jsx-tag") {
    return undefined;
  }
  return mode.lexical === undefined ? "line" : undefined;
}

function isJsxTagStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z]/.test(character);
}

function isLikelyJsxStart(source: string, index: number): boolean {
  const next = source[index + 1];
  if (next !== ">" && !isJsxTagStart(next)) {
    return false;
  }
  const previousIndex = previousNonWhitespace(source, index);
  if (previousIndex < 0) {
    return true;
  }
  const previous = source[previousIndex]!;
  if (/[=(:,[?!&|;{}]/.test(previous) || previous === ">") {
    return true;
  }
  const wordStart = previousWordStart(source, previousIndex);
  const word = source.slice(wordStart, previousIndex + 1);
  return word === "return" || word === "yield" || word === "await";
}

function isLikelyRegexStart(source: string, index: number): boolean {
  const previousIndex = previousNonWhitespace(source, index);
  if (previousIndex < 0) {
    return true;
  }
  const previous = source[previousIndex]!;
  if (/[({[=,:;!?&|+\-*%^~<>]/.test(previous)) {
    return true;
  }
  const wordStart = previousWordStart(source, previousIndex);
  const word = source.slice(wordStart, previousIndex + 1);
  return [
    "await",
    "case",
    "delete",
    "do",
    "else",
    "in",
    "instanceof",
    "new",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
  ].includes(word);
}

function previousNonWhitespace(source: string, index: number): number {
  let previous = index - 1;
  while (previous >= 0 && /\s/.test(source[previous]!)) {
    previous -= 1;
  }
  return previous;
}

function previousWordStart(source: string, index: number): number {
  let start = index;
  while (start >= 0 && /[A-Za-z0-9_$]/.test(source[start]!)) {
    start -= 1;
  }
  return start + 1;
}

function isSelfClosingTag(source: string, end: number): boolean {
  let previous = end - 1;
  while (previous >= 0 && /\s/.test(source[previous]!)) {
    previous -= 1;
  }
  return source[previous] === "/";
}
