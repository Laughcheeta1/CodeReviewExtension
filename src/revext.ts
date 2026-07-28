export interface RevExtEdit {
  readonly line: number;
  readonly suffix: string;
}

export interface RevExtRemoval {
  readonly line: number;
  readonly start: number;
}

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

export function revExtEdits(
  lines: readonly string[],
  addedLines: ReadonlySet<number>,
  languageId: string,
  nextId: number,
): {
  readonly edits: readonly RevExtEdit[];
  readonly nextId: number;
} {
  const token = lineComments.get(languageId);
  if (token === undefined) {
    return { edits: [], nextId };
  }
  const groups = new Map<string, number[]>();
  for (const line of addedLines) {
    const text = lines[line - 1];
    if (text === undefined) {
      continue;
    }
    const key = withoutMarker(text, token);
    const matching = groups.get(key) ?? [];
    matching.push(line);
    groups.set(key, matching);
  }
  for (const line of addedLines) {
    const text = lines[line - 1];
    if (text === undefined) {
      continue;
    }
    const id = markerId(text, token);
    if (id !== undefined) {
      nextId = Math.max(nextId, id + 1);
    }
  }
  const edits: RevExtEdit[] = [];
  for (const matching of groups.values()) {
    if (matching.length < 2) {
      continue;
    }
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
    }
  }
  return { edits, nextId };
}

export function revExtRemovals(
  lines: readonly string[],
  addedLines: ReadonlySet<number>,
  languageId: string,
): readonly RevExtRemoval[] {
  const token = lineComments.get(languageId);
  if (token === undefined) {
    return [];
  }
  const result: RevExtRemoval[] = [];
  for (const line of addedLines) {
    const text = lines[line - 1];
    if (text === undefined) {
      continue;
    }
    const match = markerExpression(token).exec(text);
    if (match !== null) {
      result.push({ line, start: match.index });
    }
  }
  return result;
}

function hasMarker(line: string, token: string): boolean {
  return markerExpression(token).test(line);
}

function markerId(line: string, token: string): number | undefined {
  const match = new RegExp(`(?:${escape(token)})\\s+RevExt: ([1-9]\\d*)$`).exec(
    line,
  );
  return match === null ? undefined : Number(match[1]);
}

function withoutMarker(line: string, token: string): string {
  return line.replace(markerExpression(token), "");
}

function markerExpression(token: string): RegExp {
  return new RegExp(
    `\\s{2}${escape(token)}\\s+RevExt: [1-9]\\d*$|^\\s*${escape(token)}\\s+RevExt: [1-9]\\d*$`,
  );
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Do not append after explicit continuation markers; these contexts would change program meaning.
function safeForSuffix(line: string, languageId: string): boolean {
  if (line.endsWith("\\")) {
    return false;
  }
  if (languageId === "python" && /(?:'''|""")/.test(line)) {
    return false;
  }
  return true;
}
