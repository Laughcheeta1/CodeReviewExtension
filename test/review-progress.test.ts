import assert from "node:assert/strict";
import test from "node:test";
import { folderProgressMessage } from "../src/review-progress.ts";
// RevExt: 1
test("folder progress reports successful reviewed files out of the total", () => {
  assert.equal(  // RevExt: 4
    folderProgressMessage(3, 8, "reviewed"),
    "3/8 files successfully set to reviewed",
  );  // RevExt: 7
});  // RevExt: 10
// RevExt: 2
test("folder progress uses readable labels for in-review status", () => {
  assert.equal(  // RevExt: 5
    folderProgressMessage(1, 2, "inReview"),
    "1/2 files successfully set to in review",
  );  // RevExt: 8
});  // RevExt: 11
// RevExt: 3
test("folder progress reports pending files out of the total", () => {
  assert.equal(  // RevExt: 6
    folderProgressMessage(0, 5, "pending"),
    "0/5 files successfully set to pending",
  );  // RevExt: 9
});  // RevExt: 12
