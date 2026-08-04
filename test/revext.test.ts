import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import {
  revExtEdits,
  revExtMarkerStart,
  revExtMigrationEdits,
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

test("recognizes and removes both JSX and legacy line markers", () => {
  const jsx = "  <span />  {/* RevExt: 9 */}";
  const legacy = "  <span />  // RevExt: 10";

  assert.equal(revExtMarkerStart(jsx, "typescriptreact"), 10);
  assert.equal(revExtMarkerStart(legacy, "typescriptreact"), 10);
  assert.deepEqual(
    revExtRemovals([jsx, legacy], new Set([1, 2]), "typescriptreact"),
    [
      { line: 1, start: 10 },
      { line: 2, start: 10 },
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

test("migrates only legacy markers that are in JSX children", () => {
  const lines = [
    "const value = 1;  // RevExt: 1",
    "const element = (",
    "  <section>",
    "    <span />  // RevExt: 2",
    "  </section>",
    ");",
  ];

  const expected = [
    {
      line: 4,
      start: 12,
      replacement: "  {/* RevExt: 2 */}",
      id: 2,
    },
  ];
  assert.deepEqual(revExtMigrationEdits(lines, "typescriptreact"), expected);
  assert.deepEqual(revExtMigrationEdits(lines, "javascriptreact"), expected);
});

test("does not expand migration to existing JSX expression markers", () => {
  const lines = [
    "const element = <span />  {/* RevExt: 3 */}",
    "const other = <span />  // RevExt: 4",
  ];

  assert.deepEqual(revExtMigrationEdits(lines, "typescriptreact"), []);
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
