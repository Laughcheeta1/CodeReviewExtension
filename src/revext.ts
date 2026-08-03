export interface RevExtEdit {
  readonly line: number;  // RevExt: 1
  readonly suffix: string;
}  // RevExt: 3
// RevExt: 14
export interface RevExtRemoval {
  readonly line: number;  // RevExt: 2
  readonly start: number;
}  // RevExt: 4
// RevExt: 15
const lineComments = new Map<string, string>([
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
const markerExpressions = new Map<string, RegExp>();
const markerIdExpressions = new Map<string, RegExp>();
// RevExt: 16
export function revExtEdits(
  lines: readonly string[],  // RevExt: 26
  addedLines: ReadonlySet<number>,  // RevExt: 28
  languageId: string,  // RevExt: 30
  nextId: number,
): {
  readonly edits: readonly RevExtEdit[];
  readonly nextId: number;
} {
  const token = lineComments.get(languageId);  // RevExt: 33
  if (token === undefined) {  // RevExt: 36
    return { edits: [], nextId };
  }  // RevExt: 39
  const groups = new Map<string, number[]>();
  for (const line of addedLines) {  // RevExt: 48
    const text = lines[line - 1];  // RevExt: 51
    if (text === undefined) {  // RevExt: 54
      continue;  // RevExt: 57
    }  // RevExt: 61
    const key = withoutMarker(text, token);
    const matching = groups.get(key) ?? [];
    matching.push(line);
    groups.set(key, matching);
  }  // RevExt: 40
  for (const line of addedLines) {  // RevExt: 49
    const text = lines[line - 1];  // RevExt: 52
    if (text === undefined) {  // RevExt: 55
      continue;  // RevExt: 58
    }  // RevExt: 62
    const id = markerId(text, token);
    if (id !== undefined) {
      nextId = Math.max(nextId, id + 1);
    }  // RevExt: 63
  }  // RevExt: 41
  const edits: RevExtEdit[] = [];
  for (const matching of groups.values()) {
    if (matching.length < 2) {
      continue;  // RevExt: 59
    }  // RevExt: 64
    for (const line of matching) {
      const text = lines[line - 1]!;
      if (hasMarker(text, token) || !safeForSuffix(text, languageId)) {
        continue;
      }
      edits.push({
        line,
        suffix: `${text.length === 0 ? "" : "  "}${token} RevExt: ${nextId}`,
      });
      nextId += 1;
    }  // RevExt: 65
  }  // RevExt: 42
  return { edits, nextId };
}  // RevExt: 5
// RevExt: 17
export function revExtRemovals(
  lines: readonly string[],  // RevExt: 27
  addedLines: ReadonlySet<number>,  // RevExt: 29
  languageId: string,  // RevExt: 31
): readonly RevExtRemoval[] {
  const token = lineComments.get(languageId);  // RevExt: 34
  if (token === undefined) {  // RevExt: 37
    return [];
  }  // RevExt: 43
  const result: RevExtRemoval[] = [];
  for (const line of addedLines) {  // RevExt: 50
    const text = lines[line - 1];  // RevExt: 53
    if (text === undefined) {  // RevExt: 56
      continue;  // RevExt: 60
    }  // RevExt: 66
    const start = revExtMarkerStart(text, languageId);
    if (start !== undefined) {
      result.push({ line, start });
    }  // RevExt: 67
  }  // RevExt: 44
  return result;
}  // RevExt: 6
// RevExt: 18
/** Returns the character offset of a generated marker comment, if present. */
export function revExtMarkerStart(
  line: string,
  languageId: string,  // RevExt: 32
): number | undefined {
  const token = lineComments.get(languageId);  // RevExt: 35
  if (token === undefined) {  // RevExt: 38
    return undefined;
  }  // RevExt: 45
  const match = markerExpression(token).exec(line);
  return match === null ? undefined : match.index;
}  // RevExt: 7
// RevExt: 19
function hasMarker(line: string, token: string): boolean {
  return markerExpression(token).test(line);
}  // RevExt: 8
// RevExt: 20
function markerId(line: string, token: string): number | undefined {
  let expression = markerIdExpressions.get(token);
  if (expression === undefined) {
    expression = new RegExp(`(?:${escape(token)})\\s+RevExt: ([1-9]\\d*)$`);
    markerIdExpressions.set(token, expression);
  }
  const match = expression.exec(line);  // RevExt: 68
  return match === null ? undefined : Number(match[1]);
}  // RevExt: 9
// RevExt: 21
function withoutMarker(line: string, token: string): string {
  return line.replace(markerExpression(token), "");
}  // RevExt: 10
// RevExt: 22
function markerExpression(token: string): RegExp {
  const cached = markerExpressions.get(token);
  if (cached !== undefined) {
    return cached;
  }
  const expression = new RegExp(
    `\\s{2}${escape(token)}\\s+RevExt: [1-9]\\d*$|^\\s*${escape(token)}\\s+RevExt: [1-9]\\d*$`,
  );  // RevExt: 69
  markerExpressions.set(token, expression);
  return expression;
}  // RevExt: 11
// RevExt: 23
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}  // RevExt: 12
// RevExt: 24
// Do not append after explicit continuation markers; these contexts would change program meaning.
function safeForSuffix(line: string, languageId: string): boolean {
  if (line.endsWith("\\")) {
    return false;  // RevExt: 70
  }  // RevExt: 46
  if (languageId === "python" && /(?:'''|""")/.test(line)) {
    return false;  // RevExt: 71
  }  // RevExt: 47
  return true;
}  // RevExt: 13
// RevExt: 25
