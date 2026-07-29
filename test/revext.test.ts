import assert from "node:assert/strict";
import test from "node:test";
import { revExtEdits, revExtMarkerStart } from "../src/revext.ts";
test("only duplicate added lines receive RevExt comments", () => {
  const result = revExtEdits(  // RevExt: 1
    ["one", "same", "other", "same"],
    new Set([1, 2, 3, 4]),  // RevExt: 5
    "python",  // RevExt: 7
    1,  // RevExt: 9
  );  // RevExt: 12
  assert.deepEqual(result.edits, [  // RevExt: 18
    { line: 2, suffix: "  # RevExt: 1" },
    { line: 4, suffix: "  # RevExt: 2" },
  ]);  // RevExt: 20
  assert.equal(result.nextId, 3);
});  // RevExt: 22
test("initial pending annotation tags duplicate lines before review records exist", () => {
  const result = revExtEdits(  // RevExt: 2
    ["before", "repeat", "repeat", "after"],
    new Set([1, 2, 3, 4]),  // RevExt: 6
    "typescript",  // RevExt: 28
    1,  // RevExt: 10
  );  // RevExt: 13
  assert.deepEqual(result.edits, [  // RevExt: 19
    { line: 2, suffix: "  // RevExt: 1" },
    { line: 3, suffix: "  // RevExt: 2" },
  ]);  // RevExt: 21
});  // RevExt: 23
test("an existing marker is retained while a new duplicate receives an ID", () => {
  const result = revExtEdits(  // RevExt: 3
    ["same  // RevExt: 4", "same"],
    new Set([1, 2]),  // RevExt: 30
    "typescript",  // RevExt: 29
    5,
  );  // RevExt: 14
  assert.deepEqual(result.edits, [{ line: 2, suffix: "  // RevExt: 5" }]);
  assert.equal(result.nextId, 6);
});  // RevExt: 24
test("the next marker ID never collides with an existing marker", () => {
  const result = revExtEdits(  // RevExt: 4
    ["same  # RevExt: 9", "same"],
    new Set([1, 2]),  // RevExt: 31
    "python",  // RevExt: 8
    1,  // RevExt: 11
  );  // RevExt: 15
  assert.deepEqual(result.edits, [{ line: 2, suffix: "  # RevExt: 10" }]);
  assert.equal(result.nextId, 11);
});  // RevExt: 25
test("unique additions and unsafe continuations remain unchanged", () => {
  assert.deepEqual(revExtEdits(["one"], new Set([1]), "python", 1).edits, []);
  assert.deepEqual(
    revExtEdits(["same\\", "same\\"], new Set([1, 2]), "python", 1).edits,
    [],
  );  // RevExt: 16
});  // RevExt: 26
test("generated markers expose the exact decoration start", () => {
  assert.equal(
    revExtMarkerStart("const value = 1;  // RevExt: 12", "typescript"),
    16,
  );  // RevExt: 17
  assert.equal(revExtMarkerStart("  # RevExt: 4", "python"), 0);
  assert.equal(revExtMarkerStart("// RevExt: 0", "typescript"), undefined);
  assert.equal(revExtMarkerStart("// RevExt: 4", "plaintext"), undefined);
});  // RevExt: 27
