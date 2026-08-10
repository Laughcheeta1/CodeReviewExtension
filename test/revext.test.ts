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

function applyEdits(
  lines: readonly string[],
  edits: readonly { readonly line: number; readonly suffix: string }[],
): string[] {
  const byLine = new Map(edits.map((edit) => [edit.line, edit.suffix]));
  return lines.map((line, index) => {
    const suffix = byLine.get(index + 1);
    return suffix === undefined ? line : `${line}${suffix}`;
  });
}

function sourceBytes(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

test("recognizes only physical lines containing an LF or CRLF terminator", () => {
  assert.equal(isEmptyPhysicalLine(new TextEncoder().encode("\n")), true);
  assert.equal(isEmptyPhysicalLine(new TextEncoder().encode("\r\n")), true);
  assert.equal(isEmptyPhysicalLine(new TextEncoder().encode(" \t\n")), false);
  assert.equal(isEmptyPhysicalLine(new TextEncoder().encode("")), false);
});

test("can omit empty-line deletions while preserving the metadata invariant", () => {
  const baseline = new TextEncoder().encode("before\n\nremoved\nafter\n");
  const current = new TextEncoder().encode("before\nadded\nafter\n");
  const rawHunks = [
    { oldStart: 2, oldCount: 2, newStart: 2, newCount: 1 },
  ];

  const unchanged = buildDiffRecords(baseline, current, rawHunks);
  assert.deepEqual(
    unchanged.deletedLines.map((line) => line.baselineLine),
    [2, 3],
  );
  assert.deepEqual(unchanged.hunks, rawHunks);

  const filtered = buildDiffRecords(
    baseline,
    current,
    rawHunks,
    undefined,
    { ignoreEmptyLineDeletions: true },
  );
  assert.deepEqual(
    filtered.deletedLines.map((line) => line.baselineLine),
    [3],
  );
  assert.deepEqual(
    filtered.currentLines
      .filter((line) => line.changeType === "added")
      .map((line) => line.line),
    [2],
  );
  assert.deepEqual(filtered.hunks, [
    { oldStart: 3, oldCount: 1, newStart: 2, newCount: 1 },
  ]);
});

test("filters CRLF empty-line deletions but keeps whitespace-only lines", () => {
  const baseline = new TextEncoder().encode("before\r\n\r\n \t\r\nafter\r\n");
  const current = new TextEncoder().encode("before\r\n \t\r\nafter\r\n");
  const filtered = buildDiffRecords(
    baseline,
    current,
    [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 0 }],
    undefined,
    { ignoreEmptyLineDeletions: true },
  );

  assert.deepEqual(filtered.deletedLines, []);
  assert.deepEqual(filtered.hunks, []);
});

function transpileJsx(lines: readonly string[], fileName: string): string {
  const result = ts.transpileModule(lines.join("\n"), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.Latest,
    },
    fileName,
    reportDiagnostics: true,
  });
  assert.deepEqual(result.diagnostics ?? [], []);
  return result.outputText;
}

function assertNoRuntimeMarker(output: string): void {
  const withoutComments = output
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\r\n]*/g, "");
  assert.doesNotMatch(withoutComments, /RevExt:/);
}

function fixtureLines(name: string): string[] {
  const source = readFileSync(path.join("test", "fixtures", name), "utf8");
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

test("uses JSX expression comments for JSX children", () => {
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
        { line: 6, suffix: "  {/* RevExt: 3 */}" },
        { line: 7, suffix: "  {/* RevExt: 4 */}" },
        { line: 8, suffix: "  {/* RevExt: 5 */}" },
        { line: 9, suffix: "  {/* RevExt: 6 */}" },
      ],
      nextId: 7,
    },
  );
});

test("keeps JSX expression code in JavaScript comment context", () => {
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

  assert.deepEqual(
    revExtEdits(lines, new Set([4, 5]), "javascriptreact", 1),
    {
      edits: [
        { line: 4, suffix: "  // RevExt: 1" },
        { line: 5, suffix: "  // RevExt: 2" },
      ],
      nextId: 3,
    },
  );
});

test("does not mistake comparisons for JSX and skips unfinished tags", () => {
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
      ],
      nextId: 3,
    },
  );
});

test("tracks JSX fragments nested inside JSX children", () => {
  const lines = [
    "const View = () => (",
    "  <>",
    "    <Item />",
    "    <Item />",
    "  </>",
    ");",
  ];

  assert.deepEqual(
    revExtEdits(lines, new Set([3, 4]), "typescriptreact", 1).edits,
    [
      { line: 3, suffix: "  {/* RevExt: 1 */}" },
      { line: 4, suffix: "  {/* RevExt: 2 */}" },
    ],
  );
});

test("uses JavaScript comments after root JSX elements", () => {
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
  );

  assert.deepEqual(annotation.edits, [
    { line: 4, suffix: "  // RevExt: 1" },
    { line: 8, suffix: "  // RevExt: 2" },
  ]);

  const annotated = lines.map((line, index) => {
    const edit = annotation.edits.find((value) => value.line === index + 1);
    return edit === undefined ? line : `${line}${edit.suffix}`;
  });
  const result = ts.transpileModule(annotated.join("\n"), {
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
    },
    fileName: "ternary.tsx",
    reportDiagnostics: true,
  });
  assert.deepEqual(result.diagnostics ?? [], []);
  assert.doesNotMatch(annotated[3]!, /\{\/\* RevExt:/);
  assert.doesNotMatch(annotated[7]!, /\{\/\* RevExt:/);
});

test("keeps JSX comments inside a parent element", () => {
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
      { line: 5, suffix: "  {/* RevExt: 1 */}" },
      { line: 8, suffix: "  {/* RevExt: 2 */}" },
    ],
  );
});

test("uses JavaScript comments after root fragments", () => {
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
  );

  assert.deepEqual(annotation.edits, [
    { line: 4, suffix: "  // RevExt: 1" },
    { line: 9, suffix: "  // RevExt: 2" },
  ]);
  assertNoRuntimeMarker(
    transpileJsx(applyEdits(lines, annotation.edits), "root-fragment.tsx"),
  );
});

test("covers JSX and TSX placement through the React transform", () => {
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
    },
    {
      languageId: "typescriptreact",
      fileName: "fixture.tsx",
      prefix: ["type Props = { label: string };"],
    },
  ];

  for (const variant of variants) {
    const lines = [...variant.prefix, ...baseLines];
    const offset = variant.prefix.length;
    const addedLines = new Set(
      [...addedBaseLines].map((line) => line + offset),
    );
    const annotation = revExtEdits(
      lines,
      addedLines,
      variant.languageId,
      1,
    );
    const annotated = applyEdits(lines, annotation.edits);

    assert.deepEqual(
      annotation.edits.map((edit) => edit.suffix),
      [
        "  // RevExt: 1",
        "  // RevExt: 2",
        "  // RevExt: 3",
        "  // RevExt: 4",
        "  {/* RevExt: 5 */}",
        "  {/* RevExt: 6 */}",
        "  {/* RevExt: 7 */}",
        "  {/* RevExt: 8 */}",
        "  {/* RevExt: 9 */}",
        "  {/* RevExt: 10 */}",
      ],
    );
    assert.equal(annotation.nextId, 11);
    assert.equal(
      annotated.filter((line) => line.includes("RevExt:")).length,
      10,
    );
    assertNoRuntimeMarker(transpileJsx(annotated, variant.fileName));
  }
});

test("annotates complex JSX and TSX fixtures without breaking their syntax", () => {
  const variants = [
    {
      fileName: "complex-dashboard.jsx",
      languageId: "javascriptreact",
    },
    {
      fileName: "complex-dashboard.tsx",
      languageId: "typescriptreact",
    },
  ];

  for (const variant of variants) {
    const lines = fixtureLines(variant.fileName);
    const addedLines = new Set(lines.map((_, index) => index + 1));
    const annotation = revExtEdits(
      lines,
      addedLines,
      variant.languageId,
      1,
    );
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

    assert.ok(
      annotation.edits.length >= 30,
      `${variant.fileName} should exercise many duplicate-line annotations`,
    );
    assert.ok(
      annotation.edits.some((edit) => edit.suffix.includes("{/* RevExt:")),
      `${variant.fileName} should use JSX expression comments`,
    );
    assert.ok(
      annotation.edits.some((edit) => edit.suffix.includes("// RevExt:")),
      `${variant.fileName} should use JavaScript comments outside JSX children`,
    );
    assert.deepEqual(result.diagnostics ?? [], [], variant.fileName);
    assertNoRuntimeMarker(result.outputText);
  }
});

test("does not classify JSX-looking strings, regular expressions, or comments as JSX", () => {
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
      ],
      nextId: 7,
    },
  );
});

test("handles supported languages, unsupported languages, and empty documents", () => {
  assert.equal(supportsRevExt("javascriptreact"), true);
  assert.equal(supportsRevExt("typescriptreact"), true);
  assert.equal(supportsRevExt("plaintext"), false);
  assert.deepEqual(markerStyles([], "typescriptreact"), []);
  assert.deepEqual(markerStyles(["duplicate", "duplicate"], "plaintext"), [
    undefined,
    undefined,
  ]);
});

test("recognizes and removes JSX and JavaScript marker dialects", () => {
  const jsx = "  <span />  {/* RevExt: 9 */}";
  const javascript = "const element = <span />  // RevExt: 10";

  assert.equal(revExtMarkerStart(jsx, "typescriptreact"), 10);
  assert.equal(revExtMarkerStart(javascript, "typescriptreact"), 24);
  assert.deepEqual(
    revExtRemovals([jsx, javascript], new Set([1, 2]), "typescriptreact"),
    [
      { line: 1, start: 10 },
      { line: 2, start: 24 },
    ],
  );
});

test("preserves existing JSX marker identities when annotating duplicate peers", () => {
  const lines = [
    "const View = (",
    "  <section>",
    "    <span />  {/* RevExt: 9 */}",
    "    <span />",
    "    <span />",
    "  </section>",
    ");",
  ];

  assert.deepEqual(
    revExtEdits(lines, new Set([3, 4, 5]), "typescriptreact", 1),
    {
      edits: [
        { line: 4, suffix: "  {/* RevExt: 10 */}" },
        { line: 5, suffix: "  {/* RevExt: 11 */}" },
      ],
      nextId: 12,
    },
  );
});

test("only annotates newly added duplicate lines", () => {
  const lines = ["repeat", "repeat", "repeat"];

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
    },
  );
});

test("annotates duplicate additions when a peer is added later", () => {
  const baseline = new Uint8Array();
  const previousBytes = sourceBytes(["repeat", "repeat"]);
  const previous = buildDiffRecords(
    baseline,
    previousBytes,
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }],
  );

  assert.deepEqual(
    newlyAddedLineNumbers(
      sourceBytes(["repeat", "repeat", "new", "new"]),
      new Set([1, 2, 3, 4]),
      previous,
    ),
    new Set([3, 4]),
  );
  assert.deepEqual(
    newlyAddedLineNumbers(
      sourceBytes(["repeat", "repeat", "repeat"]),
      new Set([1, 2, 3]),
      previous,
    ),
    new Set([1, 2, 3]),
  );
  assert.deepEqual(
    newlyAddedLineNumbers(
      sourceBytes(["repeat"]),
      new Set([1]),
      previous,
    ),
    new Set(),
  );
});

test("selects both equal additions when the first one was already persisted", () => {
  const baseline = new Uint8Array();
  const previousBytes = sourceBytes(["repeat"]);
  const previous = buildDiffRecords(
    baseline,
    previousBytes,
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }],
  );

  const selected = newlyAddedLineNumbers(
    sourceBytes(["repeat", "repeat"]),
    new Set([1, 2]),
    previous,
  );
  const annotation = revExtEdits(
    ["repeat", "repeat"],
    new Set([1, 2]),
    "typescript",
    1,
    selected,
  );

  assert.deepEqual(selected, new Set([1, 2]));
  assert.deepEqual(
    annotation.edits,
    [
      { line: 1, suffix: "  // RevExt: 1" },
      { line: 2, suffix: "  // RevExt: 2" },
    ],
  );
});

test("preserves reviewed duplicate decisions when save annotation changes digests", () => {
  const baseline = new Uint8Array();
  const originalBytes = sourceBytes(["repeat", "repeat"]);
  const initialDiff = buildDiffRecords(
    baseline,
    originalBytes,
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }],
  );
  const previous: FileRecord = {
    baseline: {
      file: "snapshot.gz",
      digest: digestBytes(baseline),
      codec: "gzip",
      size: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    current: {
      digest: digestBytes(originalBytes),
      modifiedAt: 1,
      size: originalBytes.byteLength,
      gitAlgorithm: "myers",
      generatedAt: "2026-01-01T00:00:00.000Z",
    },
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
  );
  const afterAnnotation = applyEdits(beforeAnnotation, annotation.edits);
  const afterBytes = sourceBytes(afterAnnotation);
  const bridged = updateAddedLineDigests(
    { ...previous, nextRevExtId: annotation.nextId },
    sourceBytes(beforeAnnotation),
    afterBytes,
    addedLines,
    new Set(annotation.edits.map((change) => change.line)),
  );
  const rebuilt = buildDiffRecords(
    baseline,
    afterBytes,
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 }],
    bridged,
  );

  assert.deepEqual(
    rebuilt.currentLines.map((line) => line.reviewStatus),
    ["pending", "reviewed", "reviewed"],
  );
  assert.match(afterAnnotation[1]!, /RevExt: 1/);
  assert.match(afterAnnotation[2]!, /RevExt: 2/);
});

test("generated JSX markers remain valid TSX and produce no JSX text node", () => {
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
  );
  const annotated = applyEdits(lines, annotation.edits);
  const renderedText = annotated.join("\n");
  assert.doesNotMatch(renderedText, />\s{2}\/\/ RevExt:/);
  assert.match(renderedText, /\{\/\* RevExt: 1 \*\/\}/);
  assertNoRuntimeMarker(transpileJsx(annotated, "fixture.tsx"));
});
