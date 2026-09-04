import assert from "node:assert/strict";
import test from "node:test";
import { folderProgressMessage } from "../src/review-progress.ts";

test("folder progress reports successful reviewed files out of the total", () => {
  assert.equal(
    folderProgressMessage(3, 8, "reviewed"),
    "3/8 files successfully set to reviewed",
  );
});

test("folder progress uses readable labels for in-review status", () => {
  assert.equal(
    folderProgressMessage(1, 2, "inReview"),
    "1/2 files successfully set to in review",
  );
});
