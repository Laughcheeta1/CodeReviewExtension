import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  buildDiffRecords,
  digestBytes,
  isEmptyPhysicalLine,
  newlyAddedLineNumbers,
  updateAddedLineDigests,
  type FileRecord,
} from "../src/domain.ts";
import {
  revExtEdits,
  revExtMarkerStart,
  revExtRemovals,
} from "../src/revext.ts";
import {
  markerStyles,
  supportsRevExt,
} from "../src/revext-syntax.ts";
// RevExt: 1
function applyEdits(
  lines: readonly string[],
  edits: readonly { readonly line: number; readonly suffix: string }[],
): string[] {
  const byLine = new Map(edits.map((edit) => [edit.line, edit.suffix]));
  return lines.map((line, index) => {
    const suffix = byLine.get(index + 1);
    return suffix === undefined ? line : `${line}${suffix}`;
  });  // RevExt: 47
}  // RevExt: 49
// RevExt: 2
function sourceBytes(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}  // RevExt: 50
// RevExt: 3
test("recognizes only physical lines containing an LF or CRLF terminator", () => {
  assert.equal(isEmptyPhysicalLine(new TextEncoder().encode("\n")), true);
  assert.equal(isEmptyPhysicalLine(new TextEncoder().encode("\r\n")), true);
  assert.equal(isEmptyPhysicalLine(new TextEncoder().encode(" \t\n")), false);
  assert.equal(isEmptyPhysicalLine(new TextEncoder().encode("")), false);
});
// RevExt: 4
test("can omit empty-line deletions while preserving the metadata invariant", () => {
  const baseline = new TextEncoder().encode("before\n\nremoved\nafter\n");
  const current = new TextEncoder().encode("before\nadded\nafter\n");
  const rawHunks = [
    { oldStart: 2, oldCount: 2, newStart: 2, newCount: 1 },
  ];
// RevExt: 5
  const unchanged = buildDiffRecords(baseline, current, rawHunks);
  assert.deepEqual(
    unchanged.deletedLines.map((line) => line.baselineLine),
    [2, 3],
  );  // RevExt: 53
  assert.deepEqual(unchanged.hunks, rawHunks);
// RevExt: 6
  const filtered = buildDiffRecords(
    baseline,
    current,
    rawHunks,
    undefined,
    { ignoreEmptyLineDeletions: true },
  );  // RevExt: 54
  assert.deepEqual(
    filtered.deletedLines.map((line) => line.baselineLine),
    [3],
  );  // RevExt: 55
  assert.deepEqual(
    filtered.currentLines
      .filter((line) => line.changeType === "added")
      .map((line) => line.line),
    [2],
  );  // RevExt: 56
  assert.deepEqual(filtered.hunks, [
    { oldStart: 3, oldCount: 1, newStart: 2, newCount: 1 },
  ]);  // RevExt: 105
});
// RevExt: 7
test("filters CRLF empty-line deletions but keeps whitespace-only lines", () => {
  const baseline = new TextEncoder().encode("before\r\n\r\n \t\r\nafter\r\n");
  const current = new TextEncoder().encode("before\r\n \t\r\nafter\r\n");
  const filtered = buildDiffRecords(
    baseline,
    current,
    [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 0 }],
    undefined,
    { ignoreEmptyLineDeletions: true },
  );  // RevExt: 57
// RevExt: 8
  assert.deepEqual(filtered.deletedLines, []);
  assert.deepEqual(filtered.hunks, []);
});
// RevExt: 9
function transpileJsx(lines: readonly string[], fileName: string): string {
  const result = ts.transpileModule(lines.join("\n"), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.Latest,
    },  // RevExt: 83
    fileName,
    reportDiagnostics: true,
  });  // RevExt: 48
  assert.deepEqual(result.diagnostics ?? [], []);
  return result.outputText;
}  // RevExt: 51
// RevExt: 10
function fixtureLines(name: string): string[] {
  const source = readFileSync(path.join("test", "fixtures", name), "utf8");
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}  // RevExt: 52
// RevExt: 11
test("uses direct line comments for JSX children", () => {
  const lines = [
    "const value = 1;",
    "const value = 1;",
    "export function View() {",
    "  return (",
    "    <section>",
    "      <span />",
    "      <span />",
    "      Loading",
    "      Loading",
    "    </section>",
    "  );",
    "}",
  ];
// RevExt: 12
  assert.deepEqual(
    revExtEdits(
      lines,
      new Set([1, 2, 6, 7, 8, 9]),
      "typescriptreact",
      1,
    ),
    {
      edits: [
        { line: 1, suffix: "  // RevExt: 1" },
        { line: 2, suffix: "  // RevExt: 2" },
        { line: 6, suffix: "  // RevExt: 3" },
        { line: 7, suffix: "  // RevExt: 4" },
        { line: 8, suffix: "  // RevExt: 5" },
        { line: 9, suffix: "  // RevExt: 6" },
      ],
      nextId: 7,
    },  // RevExt: 84
  );  // RevExt: 58
});
// RevExt: 13
test("uses direct line comments in JSX expression code", () => {
  const lines = [
    "export function View() {",
    "  return (",
    "    <section>",
    "      {items.length",
    "      {items.length",
    "      }",
    "    </section>",
    "  );",
    "}",
  ];
// RevExt: 14
  assert.deepEqual(
    revExtEdits(lines, new Set([4, 5]), "javascriptreact", 1),
    {
      edits: [
        { line: 4, suffix: "  // RevExt: 1" },
        { line: 5, suffix: "  // RevExt: 2" },
      ],
      nextId: 3,
    },  // RevExt: 85
  );  // RevExt: 59
});
// RevExt: 15
test("uses direct line comments for every React source line", () => {
  const lines = [
    "const value = left < right > result;",
    "const value = left < right > result;",
    "const element = (",
    "  <Card",
    "  <Card",
    "    title=\"review\"",
    "  />",
    ");",
  ];
// RevExt: 16
  assert.deepEqual(
    revExtEdits(
      lines,
      new Set([1, 2, 4, 5]),
      "typescriptreact",
      1,
    ),
    {
      edits: [
        { line: 1, suffix: "  // RevExt: 1" },
        { line: 2, suffix: "  // RevExt: 2" },
        { line: 4, suffix: "  // RevExt: 3" },
        { line: 5, suffix: "  // RevExt: 4" },
      ],
      nextId: 5,
    },  // RevExt: 86
  );  // RevExt: 60
});
// RevExt: 17
test("uses direct line comments for JSX fragments", () => {
  const lines = [
    "const View = () => (",
    "  <>",
    "    <Item />",
    "    <Item />",
    "  </>",
    ");",
  ];
// RevExt: 18
  assert.deepEqual(
    revExtEdits(lines, new Set([3, 4]), "typescriptreact", 1).edits,
    [
      { line: 3, suffix: "  // RevExt: 1" },
      { line: 4, suffix: "  // RevExt: 2" },
    ],
  );  // RevExt: 61
});
// RevExt: 19
test("uses direct line comments after root JSX elements", () => {
  const lines = [
    "const value = condition ? (",
    "  <label>",
    "    primary",
    "  </label>",
    ") : (",
    "  <label>",
    "    fallback",
    "  </label>",
    ");",
  ];
  const annotation = revExtEdits(
    lines,
    new Set([4, 8]),
    "typescriptreact",
    1,
  );  // RevExt: 62
// RevExt: 20
  assert.deepEqual(annotation.edits, [  // RevExt: 113
    { line: 4, suffix: "  // RevExt: 1" },
    { line: 8, suffix: "  // RevExt: 2" },
  ]);  // RevExt: 106
});
// RevExt: 21
test("uses direct line comments inside a parent element", () => {
  const lines = [
    "const value = (",
    "  <section>",
    "    <label>",
    "      primary",
    "    </label>",
    "    <label>",
    "      fallback",
    "    </label>",
    "  </section>",
    ");",
  ];
  assert.deepEqual(
    revExtEdits(
      lines,
      new Set([5, 8]),
      "typescriptreact",
      1,
    ).edits,
    [
      { line: 5, suffix: "  // RevExt: 1" },
      { line: 8, suffix: "  // RevExt: 2" },
    ],
  );  // RevExt: 63
});
// RevExt: 22
test("uses direct line comments after root fragments", () => {
  const lines = [
    "const first = (",
    "  <>",
    "    primary",
    "  </>",
    ");",
    "const second = (",
    "  <>",
    "    fallback",
    "  </>",
    ");",
  ];
  const annotation = revExtEdits(
    lines,
    new Set([4, 9]),
    "typescriptreact",
    1,
  );  // RevExt: 64
// RevExt: 23
  assert.deepEqual(annotation.edits, [  // RevExt: 114
    { line: 4, suffix: "  // RevExt: 1" },
    { line: 9, suffix: "  // RevExt: 2" },
  ]);  // RevExt: 107
});
// RevExt: 24
test("uses direct line comments for JSX and TSX", () => {
  const baseLines = [
    "const condition = true;",
    "export const Root = condition ? (",
    "  <label>",
    "    primary",
    "  </label>",
    ") : (",
    "  <label>",
    "    fallback",
    "  </label>",
    ");",
    "export const SelfClosing = condition ? (",
    "  <Widget />",
    ") : (",
    "  <Widget />",
    ");",
    "export const Nested = (",
    "  <section title=\"<Card>\">",
    "    <label>",
    "      Loading",
    "      Loading",
    "    </label>",
    "    <label>",
    "      Loading",
    "      Loading",
    "    </label>",
    "  </section>",
    ");",
  ];
  const addedBaseLines = new Set([5, 9, 12, 14, 19, 20, 21, 23, 24, 25]);
  const variants = [
    {
      languageId: "javascriptreact",
      fileName: "fixture.jsx",
      prefix: [],
    },  // RevExt: 87
    {
      languageId: "typescriptreact",
      fileName: "fixture.tsx",
      prefix: ["type Props = { label: string };"],
    },  // RevExt: 88
  ];
// RevExt: 25
  for (const variant of variants) {
    const lines = [...variant.prefix, ...baseLines];
    const offset = variant.prefix.length;
    const addedLines = new Set(
      [...addedBaseLines].map((line) => line + offset),
    );  // RevExt: 96
    const annotation = revExtEdits(
      lines,
      addedLines,
      variant.languageId,
      1,
    );  // RevExt: 97
    const annotated = applyEdits(lines, annotation.edits);
// RevExt: 26
    assert.deepEqual(
      annotation.edits.map((edit) => edit.suffix),
      [
        "  // RevExt: 1",
        "  // RevExt: 2",
        "  // RevExt: 3",
        "  // RevExt: 4",
        "  // RevExt: 5",
        "  // RevExt: 6",
        "  // RevExt: 7",
        "  // RevExt: 8",
        "  // RevExt: 9",
        "  // RevExt: 10",
      ],
    );  // RevExt: 98
    assert.equal(annotation.nextId, 11);
    assert.equal(
      annotated.filter((line) => line.includes("RevExt:")).length,
      10,
    );  // RevExt: 99
    assert.doesNotMatch(annotated.join("\n"), /\{\/\* RevExt:/);
  }
});
// RevExt: 27
test("annotates complex JSX and TSX fixtures with direct comments", () => {
  const variants = [
    {
      fileName: "complex-dashboard.jsx",
      languageId: "javascriptreact",
    },  // RevExt: 89
    {
      fileName: "complex-dashboard.tsx",
      languageId: "typescriptreact",
    },  // RevExt: 90
  ];
// RevExt: 28
  for (const variant of variants) {
    const lines = fixtureLines(variant.fileName);
    const addedLines = new Set(lines.map((_, index) => index + 1));
    const annotation = revExtEdits(
      lines,
      addedLines,
      variant.languageId,
      1,
    );  // RevExt: 100
    const annotated = applyEdits(lines, annotation.edits);
    const result = ts.transpileModule(annotated.join("\n"), {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.Latest,
      },
      fileName: variant.fileName,
      reportDiagnostics: true,
    });
// RevExt: 29
    assert.ok(  // RevExt: 103
      annotation.edits.length >= 30,
      `${variant.fileName} should exercise many duplicate-line annotations`,
    );  // RevExt: 101
    assert.ok(  // RevExt: 104
      annotation.edits.every((edit) => edit.suffix.includes("// RevExt:")),
      `${variant.fileName} should use direct line comments`,
    );  // RevExt: 102
    assert.deepEqual(result.diagnostics ?? [], [], variant.fileName);
    assert.match(result.outputText, /RevExt:/, variant.fileName);
  }
});
// RevExt: 30
test("annotates duplicate lines regardless of React lexical context", () => {
  const lines = [
    'const text = "<Card>";',
    'const text = "<Card>";',
    "const template = `<Card>`;",
    "const template = `<Card>`;",
    "const pattern = /<Card>/;",
    "const pattern = /<Card>/;",
    "// <Card>",
    "// <Card>",
  ];
// RevExt: 31
  assert.deepEqual(
    revExtEdits(
      lines,
      new Set([1, 2, 3, 4, 5, 6, 7, 8]),
      "typescriptreact",
      1,
    ),
    {
      edits: [
        { line: 1, suffix: "  // RevExt: 1" },
        { line: 2, suffix: "  // RevExt: 2" },
        { line: 3, suffix: "  // RevExt: 3" },
        { line: 4, suffix: "  // RevExt: 4" },
        { line: 5, suffix: "  // RevExt: 5" },
        { line: 6, suffix: "  // RevExt: 6" },
        { line: 7, suffix: "  // RevExt: 7" },
        { line: 8, suffix: "  // RevExt: 8" },
      ],
      nextId: 9,
    },  // RevExt: 91
  );  // RevExt: 65
});
// RevExt: 32
test("handles supported languages, unsupported languages, and empty documents", () => {
  assert.equal(supportsRevExt("javascriptreact"), true);
  assert.equal(supportsRevExt("typescriptreact"), true);
  assert.equal(supportsRevExt("plaintext"), false);
  assert.deepEqual(markerStyles([], "typescriptreact"), []);
  assert.deepEqual(markerStyles(["first", "second"], "typescriptreact"), [
    "line",  // RevExt: 110
    "line",  // RevExt: 111
  ]);  // RevExt: 108
  assert.deepEqual(markerStyles(["duplicate", "duplicate"], "plaintext"), [
    undefined,
    undefined,
  ]);  // RevExt: 109
});
// RevExt: 33
test("recognizes direct markers and removes legacy JSX markers", () => {
  const jsx = "  <span />  {/* RevExt: 9 */}";
  const javascript = "const element = <span />  // RevExt: 10";
// RevExt: 34
  assert.equal(revExtMarkerStart(jsx, "typescriptreact"), 10);
  assert.equal(revExtMarkerStart(javascript, "typescriptreact"), 24);
  assert.deepEqual(
    revExtRemovals([jsx, javascript], new Set([1, 2]), "typescriptreact"),
    [
      { line: 1, start: 10 },
      { line: 2, start: 24 },
    ],
  );  // RevExt: 66
});
// RevExt: 35
test("preserves legacy JSX marker identities when annotating duplicate peers", () => {
  const lines = [
    "const View = (",
    "  <section>",
    "    <span />  {/* RevExt: 9 */}",
    "    <span />",
    "    <span />",
    "  </section>",
    ");",
  ];
// RevExt: 36
  assert.deepEqual(
    revExtEdits(lines, new Set([3, 4, 5]), "typescriptreact", 1),
    {
      edits: [
        { line: 4, suffix: "  // RevExt: 10" },
        { line: 5, suffix: "  // RevExt: 11" },
      ],
      nextId: 12,
    },  // RevExt: 92
  );  // RevExt: 67
});
// RevExt: 37
test("only annotates newly added duplicate lines", () => {
  const lines = ["repeat", "repeat", "repeat"];
// RevExt: 38
  assert.deepEqual(
    revExtEdits(
      lines,
      new Set([1, 2, 3]),
      "typescript",
      1,
      new Set([3]),
    ),
    {
      edits: [{ line: 3, suffix: "  // RevExt: 1" }],
      nextId: 2,
    },  // RevExt: 93
  );  // RevExt: 68
});
// RevExt: 39
test("annotates duplicate additions when a peer is added later", () => {
  const baseline = new Uint8Array();
  const previousBytes = sourceBytes(["repeat", "repeat"]);
  const previous = buildDiffRecords(
    baseline,
    previousBytes,
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }],
  );  // RevExt: 69
// RevExt: 40
  assert.deepEqual(
    newlyAddedLineNumbers(
      sourceBytes(["repeat", "repeat", "new", "new"]),
      new Set([1, 2, 3, 4]),
      previous,
    ),
    new Set([3, 4]),
  );  // RevExt: 70
  assert.deepEqual(
    newlyAddedLineNumbers(
      sourceBytes(["repeat", "repeat", "repeat"]),
      new Set([1, 2, 3]),
      previous,
    ),
    new Set([1, 2, 3]),
  );  // RevExt: 71
  assert.deepEqual(
    newlyAddedLineNumbers(
      sourceBytes(["repeat"]),
      new Set([1]),
      previous,
    ),
    new Set(),
  );  // RevExt: 72
});
// RevExt: 41
test("selects both equal additions when the first one was already persisted", () => {
  const baseline = new Uint8Array();
  const previousBytes = sourceBytes(["repeat"]);
  const previous = buildDiffRecords(
    baseline,
    previousBytes,
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }],
  );  // RevExt: 73
// RevExt: 42
  const selected = newlyAddedLineNumbers(
    sourceBytes(["repeat", "repeat"]),
    new Set([1, 2]),
    previous,
  );  // RevExt: 74
  const annotation = revExtEdits(
    ["repeat", "repeat"],
    new Set([1, 2]),
    "typescript",
    1,
    selected,
  );  // RevExt: 75
// RevExt: 43
  assert.deepEqual(selected, new Set([1, 2]));
  assert.deepEqual(
    annotation.edits,
    [
      { line: 1, suffix: "  // RevExt: 1" },
      { line: 2, suffix: "  // RevExt: 2" },
    ],
  );  // RevExt: 76
});
// RevExt: 44
test("preserves reviewed duplicate decisions when save annotation changes digests", () => {
  const baseline = new Uint8Array();
  const originalBytes = sourceBytes(["repeat", "repeat"]);
  const initialDiff = buildDiffRecords(
    baseline,
    originalBytes,
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }],
  );  // RevExt: 77
  const previous: FileRecord = {
    baseline: {
      file: "snapshot.gz",
      digest: digestBytes(baseline),
      codec: "gzip",
      size: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    },  // RevExt: 94
    current: {
      digest: digestBytes(originalBytes),
      modifiedAt: 1,
      size: originalBytes.byteLength,
      gitAlgorithm: "myers",
      generatedAt: "2026-01-01T00:00:00.000Z",
    },  // RevExt: 95
    fileStatus: "reviewed",
    ...initialDiff,
    currentLines: initialDiff.currentLines.map((line) => ({
      ...line,
      reviewStatus: "reviewed",
    })),
    nextRevExtId: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const beforeAnnotation = ["new line", "repeat", "repeat"];
  const addedLines = new Set([1, 2, 3]);
  const annotation = revExtEdits(
    beforeAnnotation,
    addedLines,
    "typescript",
    previous.nextRevExtId,
  );  // RevExt: 78
  const afterAnnotation = applyEdits(beforeAnnotation, annotation.edits);
  const afterBytes = sourceBytes(afterAnnotation);
  const bridged = updateAddedLineDigests(
    { ...previous, nextRevExtId: annotation.nextId },
    sourceBytes(beforeAnnotation),
    afterBytes,
    addedLines,
    new Set(annotation.edits.map((change) => change.line)),
  );  // RevExt: 79
  const rebuilt = buildDiffRecords(
    baseline,
    afterBytes,
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 }],
    bridged,
  );  // RevExt: 80
// RevExt: 45
  assert.deepEqual(
    rebuilt.currentLines.map((line) => line.reviewStatus),
    ["pending", "reviewed", "reviewed"],
  );  // RevExt: 81
  assert.match(afterAnnotation[1]!, /RevExt: 1/);
  assert.match(afterAnnotation[2]!, /RevExt: 2/);
});
// RevExt: 46
test("generates direct line comments inside JSX and TSX", () => {
  const lines = [
    "export function View({ items }: { items: string[] }) {",
    "  return (",
    "    <section>",
    "      <span>{items[0]}</span>",
    "      <span />",
    "      <span />",
    "    </section>",
    "  );",
    "}",
  ];
  const annotation = revExtEdits(
    lines,
    new Set([5, 6]),
    "typescriptreact",
    1,
  );  // RevExt: 82
  const annotated = applyEdits(lines, annotation.edits);
  const renderedText = annotated.join("\n");
  assert.deepEqual(annotation.edits, [  // RevExt: 115
    { line: 5, suffix: "  // RevExt: 1" },
    { line: 6, suffix: "  // RevExt: 2" },
  ]);  // RevExt: 112
  assert.doesNotMatch(renderedText, /\{\/\* RevExt:/);
  assert.match(renderedText, /<span \/>\s{2}\/\/ RevExt: 1/);
  assert.match(transpileJsx(annotated, "fixture.tsx"), /RevExt:/);
});
