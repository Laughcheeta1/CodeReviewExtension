import assert from "node:assert/strict";
import test from "node:test";
import {
  baselineLineDigest,
  buildDiffRecords,
  digestBytes,
  fileStatus,
  physicalLines,
  reviewCounts,
  terminalPayload,
  type FileRecord,
  type RawGitHunk,
} from "../src/domain.ts";
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
function record(
  baseline: string,
  current: string,
  hunks: readonly RawGitHunk[],
): FileRecord {
  const baselineBytes = bytes(baseline);
  const currentBytes = bytes(current);
  const diff = buildDiffRecords(baselineBytes, currentBytes, hunks);
  return {
    baseline: {
      file: `x.${digestBytes(baselineBytes)}.gz`,
      digest: digestBytes(baselineBytes),
      codec: "gzip",
      size: baselineBytes.byteLength,
      createdAt: "now",
    },
    current: {
      digest: digestBytes(currentBytes),
      modifiedAt: 1,
      size: currentBytes.byteLength,
      gitAlgorithm: "myers",
      generatedAt: "now",
    },
    fileStatus: fileStatus(diff),
    nextRevExtId: 1,
    ...diff,
    updatedAt: "now",
  };
}
test("physical lines include blank lines and line-ending identity", () => {
  const lines = physicalLines(bytes("one\r\n\r\nthree"));
  assert.equal(lines.length, 3);
  assert.equal(lines[1]?.digest, digestBytes(bytes("\r\n")));
  assert.notEqual(lines[0]?.digest, physicalLines(bytes("one\n"))[0]?.digest);
  assert.notEqual(lines[2]?.digest, physicalLines(bytes("three\n"))[0]?.digest);
});
test("baseline identities include their immutable line number", () => {
  const line = bytes("same\n");
  assert.notEqual(baselineLineDigest(line, 1), baselineLineDigest(line, 2));
});
test("replacement is represented as independent deletion and addition", () => {
  const result = buildDiffRecords(bytes("old\n"), bytes("new\n"), [
    { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
  ]);
  assert.deepEqual(
    result.currentLines.map((line) => line.changeType),
    ["added"],
  );
  assert.equal(result.deletedLines.length, 1);
  assert.deepEqual(result.hunks[0], {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
  });
  assert.equal(fileStatus(result as FileRecord), "pending");
});
test("unchanged ranges are filled around additions and deletions", () => {
  const result = buildDiffRecords(bytes("a\nb\nc\n"), bytes("a\nx\nc\n"), [
    { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
  ]);
  assert.deepEqual(
    result.currentLines.map((line) => [line.line, line.changeType]),
    [
      [1, "unchanged"],
      [2, "added"],
      [3, "unchanged"],
    ],
  );
  assert.equal(result.currentLines[0]?.reviewStatus, "reviewed");
  assert.equal(result.deletedLines[0]?.baselineLine, 2);
});
test("deleting all content produces deletion records without phantom current lines", () => {
  const result = buildDiffRecords(bytes("one\n\n"), new Uint8Array(), [
    { oldStart: 1, oldCount: 2, newStart: 0, newCount: 0 },
  ]);
  assert.equal(result.currentLines.length, 0);
  assert.deepEqual(
    result.deletedLines.map((line) => line.baselineLine),
    [1, 2],
  );
});
test("zero-count insertion hunk preserves unchanged lines before and after it", () => {
  const result = buildDiffRecords(bytes("a\nc\n"), bytes("a\nb\nc\n"), [
    { oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 },
  ]);
  assert.deepEqual(
    result.currentLines.map((line) => [line.line, line.changeType]),
    [
      [1, "unchanged"],
      [2, "added"],
      [3, "unchanged"],
    ],
  );
});
test("zero-count deletion hunk preserves unchanged lines around the deletion", () => {
  const result = buildDiffRecords(bytes("a\nb\nc\n"), bytes("a\nc\n"), [
    { oldStart: 2, oldCount: 1, newStart: 1, newCount: 0 },
  ]);
  assert.deepEqual(
    result.currentLines.map((line) => [line.line, line.changeType]),
    [
      [1, "unchanged"],
      [2, "unchanged"],
    ],
  );
  assert.equal(result.deletedLines[0]?.baselineLine, 2);
});
test("addition review state transfers by digest and occurrence when duplicate cardinality is stable", () => {
  const initial = buildDiffRecords(new Uint8Array(), bytes("same\nsame\n"), [
    { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
  ]);
  const previous = {
    ...record("", "same\nsame\n", [
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
    ]),
    currentLines: initial.currentLines.map((line, index) =>
      index === 0
        ? {
            ...line,
            reviewStatus: "reviewed" as const,
            lastReviewer: { name: "Ada", time: "now" },
          }
        : {
            ...line,
            reviewStatus: "inReview" as const,
            lastReviewer: { name: "Ada", time: "now" },
          },
    ),
  };
  const next = buildDiffRecords(
    new Uint8Array(),
    bytes("same\nsame\n"),
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }],
    previous,
  );
  assert.equal(next.currentLines[0]?.reviewStatus, "reviewed");
  assert.equal(next.currentLines[1]?.reviewStatus, "inReview");
});
test("ambiguous duplicate additions reset pending when their cardinality changes", () => {
  const initial = buildDiffRecords(new Uint8Array(), bytes("same\nsame\n"), [
    { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
  ]);
  const previous: FileRecord = {
    ...record("", "same\nsame\n", [
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
    ]),
    currentLines: initial.currentLines.map((line, index) =>
      index === 0
        ? {
            ...line,
            reviewStatus: "reviewed",
            lastReviewer: { name: "Ada", time: "now" },
          }
        : line,
    ),
  };
  const next = buildDiffRecords(
    new Uint8Array(),
    bytes("same\n"),
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }],
    previous,
  );
  assert.equal(next.currentLines[0]?.reviewStatus, "pending");
  assert.equal(next.currentLines[0]?.lastReviewer, undefined);
});
test("reviewed additions survive line movement but edited additions reset pending", () => {
  const initial = record("a\nb\n", "x\na\nb\n", [
    { oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 },
  ]);
  const reviewed: FileRecord = {
    ...initial,
    currentLines: initial.currentLines.map((line) =>
      line.changeType === "added"
        ? {
            ...line,
            reviewStatus: "reviewed",
            lastReviewer: { name: "Ada", time: "now" },
          }
        : line,
    ),
  };
  const moved = buildDiffRecords(
    bytes("a\nb\n"),
    bytes("a\nx\nb\n"),
    [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 }],
    reviewed,
  );
  assert.equal(moved.currentLines[1]?.reviewStatus, "reviewed");
  const edited = buildDiffRecords(
    bytes("a\nb\n"),
    bytes("a\ny\nb\n"),
    [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 }],
    reviewed,
  );
  assert.equal(edited.currentLines[1]?.reviewStatus, "pending");
});
test("removed additions disappear and restored deletions become unchanged", () => {
  const added = record("a\n", "a\nx\n", [
    { oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 },
  ]);
  const withoutAddition = buildDiffRecords(
    bytes("a\n"),
    bytes("a\n"),
    [],
    added,
  );
  assert.equal(
    withoutAddition.currentLines.some((line) => line.changeType === "added"),
    false,
  );
  const deleted = record("gone\nkeep\n", "keep\n", [
    { oldStart: 1, oldCount: 1, newStart: 0, newCount: 0 },
  ]);
  const reviewedDeletion: FileRecord = {
    ...deleted,
    deletedLines: deleted.deletedLines.map((line) => ({
      ...line,
      reviewStatus: "reviewed",
      lastReviewer: { name: "Ada", time: "now" },
    })),
  };
  const stillDeleted = buildDiffRecords(
    bytes("gone\nkeep\n"),
    bytes("keep\n"),
    [{ oldStart: 1, oldCount: 1, newStart: 0, newCount: 0 }],
    reviewedDeletion,
  );
  assert.equal(stillDeleted.deletedLines[0]?.reviewStatus, "reviewed");
  const restored = buildDiffRecords(
    bytes("gone\nkeep\n"),
    bytes("gone\nkeep\n"),
    [],
    reviewedDeletion,
  );
  assert.equal(restored.deletedLines.length, 0);
  assert.ok(
    restored.currentLines.every(
      (line) =>
        line.changeType === "unchanged" && line.reviewStatus === "reviewed",
    ),
  );
});
test("file status and counts are derived from reviewable additions and deletions", () => {
  const pending = record("old\n", "new\n", [
    { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
  ]);
  const mixed: FileRecord = {
    ...pending,
    currentLines: pending.currentLines.map((line) => ({
      ...line,
      reviewStatus: "reviewed",
      lastReviewer: { name: "Ada", time: "now" },
    })),
  };
  assert.equal(fileStatus(mixed), "inReview");
  assert.deepEqual(reviewCounts(mixed), { reviewed: 1, total: 2 });
  const reviewed: FileRecord = {
    ...mixed,
    deletedLines: mixed.deletedLines.map((line) => ({
      ...line,
      reviewStatus: "reviewed",
      lastReviewer: { name: "Ada", time: "now" },
    })),
  };
  assert.equal(fileStatus(reviewed), "reviewed");
});
test("invalid UTF-8 is rejected", () => {
  assert.throws(() => physicalLines(Uint8Array.of(0xc3, 0x28)));
});
test("terminal context supports multiple ranges", () => {
  const payload = terminalPayload("src/example.ts", "one\ntwo\nthree", [
    { start: 0, end: 2 },
    { start: 2, end: 2 },
  ]);
  assert.match(payload, /> Line 1 - 2, file src\/example.ts:/);
  assert.match(payload, /> Line 3, file src\/example.ts:/);
});
