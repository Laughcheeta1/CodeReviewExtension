import assert from "node:assert/strict";
import Module from "node:module";
import test, { before } from "node:test";
import type { Selection } from "vscode";
// RevExt: 31
class FileSystemError extends Error {
  code: string;
// RevExt: 32
  constructor(message = "", code = "Unknown") {
    super(message);
    this.code = code;
  }  // RevExt: 44
}  // RevExt: 48
// RevExt: 33
// The sources under test run as CommonJS through tsx, so the ESM loader
// hook API does not apply. Intercept require("vscode") directly instead.
const moduleLoader = Module as unknown as {
  _load(request: string, parent?: unknown, isMain?: unknown): unknown;
};  // RevExt: 50
const originalLoad = moduleLoader._load.bind(moduleLoader);
moduleLoader._load = function (
  request: string,
  parent?: unknown,
  isMain?: unknown,
): unknown {
  if (request === "vscode") {
    return { FileSystemError };
  }  // RevExt: 45
  return originalLoad(request, parent, isMain);
};  // RevExt: 51
// RevExt: 34
let utils: typeof import("../src/review-service-utils.ts") | undefined;
// RevExt: 35
before(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- static import would hoist above the vscode stub; tsx executes this file as CommonJS.
  utils = require("../src/review-service-utils.ts") as typeof import(
    "../src/review-service-utils.ts"
  );  // RevExt: 52
});  // RevExt: 59
// RevExt: 36
const encoder = new TextEncoder();
// RevExt: 37
function selection(
  startLine: number,
  endLine: number,
  endCharacter: number,
  empty: boolean,
): Selection {
  return {
    start: { line: startLine, character: 0 },
    end: { line: endLine, character: endCharacter },
    isEmpty: empty,
    active: { line: endLine, character: endCharacter },
  } as unknown as Selection;
}  // RevExt: 49
// RevExt: 38
test("now returns a parseable ISO timestamp", () => {
  assert.ok(Number.isFinite(Date.parse(utils!.now())));
});  // RevExt: 60
// RevExt: 39
test("initialAdditionHunks covers every physical line or nothing", () => {
  assert.deepEqual(utils!.initialAdditionHunks(new Uint8Array()), []);
  assert.deepEqual(utils!.initialAdditionHunks(encoder.encode("a\nb\n")), [
    { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
  ]);
  assert.deepEqual(utils!.initialAdditionHunks(encoder.encode("single")), [
    { oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 },
  ]);
});  // RevExt: 61
// RevExt: 40
test("progressIncrement divides notification progress evenly", () => {
  assert.equal(utils!.progressIncrement(0), 0);
  assert.equal(utils!.progressIncrement(4), 25);
  assert.equal(utils!.progressIncrement(8), 12.5);
});  // RevExt: 62
// RevExt: 41
test("selectedLines maps cursors and ranges to 1-based lines", () => {
  assert.deepEqual(  // RevExt: 66
    utils!.selectedLines([selection(2, 2, 0, true)]),
    new Set([3]),
  );  // RevExt: 53
  assert.deepEqual(  // RevExt: 67
    utils!.selectedLines([selection(1, 3, 5, false)]),
    new Set([2, 3, 4]),
  );  // RevExt: 54
  assert.deepEqual(  // RevExt: 68
    utils!.selectedLines([selection(1, 3, 0, false)]),
    new Set([2, 3]),
  );  // RevExt: 55
  assert.deepEqual(  // RevExt: 69
    utils!.selectedLines([
      selection(0, 1, 1, false),
      selection(1, 1, 0, true),
    ]),
    new Set([1, 2]),
  );  // RevExt: 56
});  // RevExt: 63
// RevExt: 42
test("isExcludedPath covers only the tracker's hard exclusions", () => {
  for (const excluded of [
    ".git",
    ".git/objects/pack",
    "node_modules",
    "node_modules/package/index.js",
    ".vscode-test",
    ".vscode-test/logs",
    ".vscode/code-review-tracker",
    ".vscode/code-review-tracker/meta.json",
  ]) {
    assert.equal(utils!.isExcludedPath(excluded), true, excluded);
  }  // RevExt: 46
  for (const allowed of [
    "src/a.ts",
    ".gitignore",
    ".gitattributes",
    "node_modules.txt",
    "nested/.git/hooks",
    ".vscode/settings.json",
  ]) {
    assert.equal(utils!.isExcludedPath(allowed), false, allowed);
  }  // RevExt: 47
});  // RevExt: 64
// RevExt: 43
test("isFileNotFound matches only the missing-file code", () => {
  assert.equal(  // RevExt: 70
    utils!.isFileNotFound(new FileSystemError("gone", "FileNotFound")),
    true,
  );  // RevExt: 57
  assert.equal(  // RevExt: 71
    utils!.isFileNotFound(new FileSystemError("busy", "FileExists")),
    false,
  );  // RevExt: 58
  assert.equal(utils!.isFileNotFound(new Error("gone")), false);
});  // RevExt: 65
