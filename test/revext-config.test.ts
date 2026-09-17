import assert from "node:assert/strict";
import test from "node:test";
import type { Uri } from "vscode";
import {
  isRevExtDisabled,
  isRevExtDisabledWithWorkspaceConfig,
  isRevExtIgnoredByWorkspaceConfig,
  parseRevExtWorkspaceConfig,
  REVIEW_EXTENSION_CONFIG_RELPATH,
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

test("exposes the shared workspace config path", () => {
  assert.equal(REVIEW_EXTENSION_CONFIG_RELPATH, ".vscode/review-extension.json");
});

test("workspace root folder disables markers throughout the workspace", () => {
  const config = parseRevExtWorkspaceConfig({ revExtIgnoredFolders: [".", "./"] });
  assert.deepEqual(config.folders, ["."]);
  assert.equal(isRevExtIgnoredByWorkspaceConfig("root.ts", config), true);
  assert.equal(isRevExtIgnoredByWorkspaceConfig("nested/source.ts", config), true);
  assert.equal(isRevExtIgnoredByWorkspaceConfig("", config), false);
});

test("matches shared workspace files, folders, and extensions", () => {
  const config = parseRevExtWorkspaceConfig({
    revExtIgnoredFiles: ["src/generated.ts"],
    revExtIgnoredFolders: ["generated/", "src/__generated__"],
    revExtIgnoredExtensions: [".HTML", "md"],
  });
  assert.deepEqual(config.files, ["src/generated.ts"]);
  assert.deepEqual(config.folders, ["generated", "src/__generated__"]);
  assert.deepEqual(config.extensions, ["html", "md"]);
  assert.equal(isRevExtIgnoredByWorkspaceConfig("src/generated.ts", config), true);
  assert.equal(isRevExtIgnoredByWorkspaceConfig("src/other.ts", config), false);
  assert.equal(isRevExtIgnoredByWorkspaceConfig("generated/a.ts", config), true);
  assert.equal(isRevExtIgnoredByWorkspaceConfig("generated", config), true);
  assert.equal(isRevExtIgnoredByWorkspaceConfig("src/__generated__/a.ts", config), true);
  assert.equal(isRevExtIgnoredByWorkspaceConfig("src/other/page.HTML", config), true);
  assert.equal(isRevExtIgnoredByWorkspaceConfig("docs/readme.md", config), true);
  assert.equal(isRevExtIgnoredByWorkspaceConfig("src/component.tsx.map", config), false);
});

test("normalizes backslashes, leading segments, and alias extension keys", () => {
  const config = parseRevExtWorkspaceConfig({
    revExtIgnoredFiles: ["\\src\\dup.ts", "./src/dup.ts", "/src/dup.ts"],
    revExtIgnoredFolders: [".", "", "  docs// "],
    revExtDisabledExtensions: [" TSX "],
  });
  assert.deepEqual(config.files, ["src/dup.ts"]);
  assert.deepEqual(config.folders, [".", "docs"]);
  assert.deepEqual(config.extensions, ["tsx"]);
  assert.equal(isRevExtIgnoredByWorkspaceConfig("src\\dup.ts", config), true);
  assert.equal(isRevExtIgnoredByWorkspaceConfig("docs/guide.txt", config), true);
});

test("ignores invalid workspace config shapes", () => {
  assert.deepEqual(parseRevExtWorkspaceConfig(undefined), {
    files: [],
    folders: [],
    extensions: [],
  });
  assert.deepEqual(parseRevExtWorkspaceConfig([]), {
    files: [],
    folders: [],
    extensions: [],
  });
  const config = parseRevExtWorkspaceConfig({
    revExtIgnoredFiles: [42, "", "   "],
    revExtIgnoredFolders: [undefined],
    revExtIgnoredExtensions: ["", "."],
  });
  assert.deepEqual(config, { files: [], folders: [], extensions: [] });
  assert.equal(isRevExtIgnoredByWorkspaceConfig("src/a.ts", config), false);
  assert.equal(isRevExtIgnoredByWorkspaceConfig("src/a.ts", undefined), false);
});

test("combines user extensions with the shared workspace config", () => {
  const config = parseRevExtWorkspaceConfig({
    revExtIgnoredFiles: ["src/skip.ts"],
    revExtIgnoredFolders: [],
    revExtIgnoredExtensions: [],
  });
  assert.equal(
    isRevExtDisabledWithWorkspaceConfig("src/skip.ts", [], "src/skip.ts", config),
    true,
  );
  assert.equal(
    isRevExtDisabledWithWorkspaceConfig("src/other.md", ["md"], "src/other.md", config),
    true,
  );
  assert.equal(
    isRevExtDisabledWithWorkspaceConfig("src/keep.ts", [], "src/keep.ts", config),
    false,
  );
});
