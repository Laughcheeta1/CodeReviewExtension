import assert from "node:assert/strict";
import test from "node:test";
import type { Uri } from "vscode";
import {
  isRevExtDisabled,
  REVEXT_DISABLED_EXTENSIONS_SETTING,
} from "../src/revext-config.ts";

test("exposes the RevExt disabled-extension setting key", () => {
  assert.equal(
    REVEXT_DISABLED_EXTENSIONS_SETTING,
    "revExtDisabledExtensions",
  );
});

test("matches extensions with optional dots, whitespace, and case differences", () => {
  assert.equal(isRevExtDisabled("src/Component.TsX", [" .TSX "]), true);
  assert.equal(isRevExtDisabled("src/readme.MD", ["md"]), true);
  assert.equal(isRevExtDisabled("src/readme.md", undefined), false);
});

test("accepts URI-like paths and Windows separators", () => {
  const uri = { fsPath: "C:\\workspace\\Component.HTML" } as Uri;
  assert.equal(isRevExtDisabled(uri, [".html"]), true);
});

test("matches only the final extension and ignores hidden or extensionless files", () => {
  assert.equal(isRevExtDisabled("src/component.tsx.map", ["tsx"]), false);
  assert.equal(isRevExtDisabled("src/.env", ["env"]), false);
  assert.equal(isRevExtDisabled("src/README", ["readme"]), false);
  assert.equal(isRevExtDisabled("src/file.", ["file"]), false);
});
