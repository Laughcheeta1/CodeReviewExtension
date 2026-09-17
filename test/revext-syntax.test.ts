import assert from "node:assert/strict";
import test from "node:test";
import {
  findRevExtMarker,
  markerStyles,
  markerSuffix,
  stripRevExtMarker,
  supportsRevExt,
} from "../src/revext-syntax.ts";

const tokenByLanguage: Readonly<Record<string, string>> = {
  javascript: "//",
  javascriptreact: "//",
  typescript: "//",
  typescriptreact: "//",
  java: "//",
  c: "//",
  cpp: "//",
  csharp: "//",
  go: "//",
  rust: "//",
  swift: "//",
  kotlin: "//",
  scala: "//",
  dart: "//",
  php: "//",
  fsharp: "//",
  groovy: "//",
  "objective-c": "//",
  "objective-cpp": "//",
  solidity: "//",
  python: "#",
  ruby: "#",
  shellscript: "#",
  powershell: "#",
  r: "#",
  julia: "#",
  perl: "#",
  elixir: "#",
  sql: "--",
  lua: "--",
  haskell: "--",
  erlang: "%",
  clojure: ";",
  lisp: ";",
  scheme: ";",
  vb: "'",
  asm: ";",
  assembly: ";",
};

test("every documented language maps to its comment token", () => {
  for (const [languageId, token] of Object.entries(tokenByLanguage)) {
    assert.equal(supportsRevExt(languageId), true, languageId);
    assert.equal(
      markerSuffix("code", languageId, "line", 3),
      `  ${token} RevExt: 3`,
      languageId,
    );
    const tagged = `code${markerSuffix("code", languageId, "line", 3)}`;
    const marker = findRevExtMarker(tagged, languageId);
    assert.equal(marker?.id, 3, languageId);
    assert.equal(stripRevExtMarker(tagged, languageId), "code", languageId);
    assert.deepEqual(markerStyles(["a", "b"], languageId), ["line", "line"]);
  }
});

test("unsupported languages are left untouched", () => {
  for (const languageId of ["plaintext", "markdown", "json", "yaml", "html", "css"]) {
    assert.equal(supportsRevExt(languageId), false, languageId);
    assert.equal(markerSuffix("code", languageId, "line", 1), "");
    assert.equal(findRevExtMarker("code  // RevExt: 1", languageId), undefined);
    assert.equal(stripRevExtMarker("code", languageId), "code");
    assert.deepEqual(markerStyles(["code"], languageId), [undefined]);
  }
});

test("marker suffixes and matches handle whole-line and invalid markers", () => {
  assert.equal(markerSuffix("", "typescript", "line", 1), "// RevExt: 1");
  assert.equal(
    findRevExtMarker("  // RevExt: 12", "typescript")?.id,
    12,
  );
  assert.equal(findRevExtMarker("code  // RevExt: 0", "typescript"), undefined);
  assert.equal(findRevExtMarker("code RevExt: 1", "typescript"), undefined);
  assert.equal(findRevExtMarker("code", "typescript"), undefined);
  assert.equal(
    stripRevExtMarker("plain line", "typescript"),
    "plain line",
  );
});
