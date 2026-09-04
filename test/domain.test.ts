import assert from "node:assert/strict";
import test from "node:test";
import {
  baselineLineDigest,
  buildDiffRecords,
  digestBytes,
  fileStatus,
  physicalLines,
  reviewableLines,
  reviewCounts,
  setReviewer,
  terminalPayload,
  type CurrentLineRecord,
  type DeletedLineRecord,
  type FileRecord,
  type ReviewStatus,
} from "../src/domain.ts";

const encoder = new TextEncoder();
const frozenTime = "2026-03-01T12:00:00.000Z";

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

interface TestCurrent {
  readonly change: "unchanged" | "added";
  readonly status: ReviewStatus;
}

function makeRecord(
  current: readonly TestCurrent[],
  deleted: readonly ReviewStatus[],
): FileRecord {
  const digest = "b".repeat(64);
  return {
    baseline: {
      file: "snap.gz",
      digest,
      codec: "gzip",
      size: 3,
      createdAt: frozenTime,
    },
    current: {
      digest,
      modifiedAt: 7,
      size: 3,
      gitAlgorithm: "myers",
      generatedAt: frozenTime,
    },
    fileStatus: "pending",
    currentLines: current.map(
      (entry, index): CurrentLineRecord => ({
        line: index + 1,
        digest,
        changeType: entry.change,
        reviewStatus: entry.status,
        occurrence: 1,
      }),
    ),
    deletedLines: deleted.map(
      (status, index): DeletedLineRecord => ({
        baselineLine: index + 1,
        digest,
        occurrence: 1,
        changeType: "deleted",
        reviewStatus: status,
      }),
    ),
    hunks: [],
    nextRevExtId: 1,
    updatedAt: frozenTime,
  };
}

test("digestBytes matches known SHA-256 vectors", () => {
  assert.equal(
    digestBytes(new Uint8Array()),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    digestBytes(bytes("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("physicalLines retains LF and CRLF terminator identity", () => {
  const lines = physicalLines(bytes("a\nb\r\nc"));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0]?.bytes, bytes("a\n"));
  assert.deepEqual(lines[1]?.bytes, bytes("b\r\n"));
  assert.deepEqual(lines[2]?.bytes, bytes("c"));
  assert.notEqual(lines[0]?.digest, lines[1]?.digest);
});

test("physicalLines treats a missing final newline and an empty file exactly", () => {
  assert.equal(physicalLines(bytes("a\n")).length, 1);
  assert.equal(physicalLines(bytes("a")).length, 1);
  assert.notEqual(
    physicalLines(bytes("a\n"))[0]?.digest,
    physicalLines(bytes("a"))[0]?.digest,
  );
  assert.deepEqual(physicalLines(new Uint8Array()), []);
  assert.equal(physicalLines(bytes("\n")).length, 1);
});

test("physicalLines concatenates back to the exact input", () => {
  const input = bytes("first\nsecond\r\nthird");
  const rebuilt = new Uint8Array(
    physicalLines(input).reduce(
      (total, line) => total + line.bytes.length,
      0,
    ),
  );
  let offset = 0;
  for (const line of physicalLines(input)) {
    rebuilt.set(line.bytes, offset);
    offset += line.bytes.length;
  }
  assert.deepEqual(rebuilt, input);
});

test("physicalLines rejects invalid UTF-8", () => {
  assert.throws(() => physicalLines(new Uint8Array([0xff])));
});

test("baselineLineDigest separates content and baseline position", () => {
  const first = baselineLineDigest(bytes("same\n"), 1);
  assert.equal(baselineLineDigest(bytes("same\n"), 1), first);
  assert.notEqual(baselineLineDigest(bytes("same\n"), 2), first);
  assert.notEqual(baselineLineDigest(bytes("other\n"), 1), first);
  assert.notEqual(baselineLineDigest(bytes("same\n"), 1), digestBytes(bytes("same\n")));
});

test("fileStatus and counts derive only from reviewable lines", () => {
  assert.equal(
    fileStatus(makeRecord([{ change: "unchanged", status: "reviewed" }], [])),
    "reviewed",
  );
  assert.deepEqual(
    reviewCounts(makeRecord([{ change: "unchanged", status: "reviewed" }], [])),
    { reviewed: 0, total: 0 },
  );
  assert.equal(
    fileStatus(makeRecord([{ change: "added", status: "pending" }], [])),
    "pending",
  );
  assert.equal(
    fileStatus(
      makeRecord(
        [
          { change: "added", status: "pending" },
          { change: "added", status: "inReview" },
        ],
        [],
      ),
    ),
    "inReview",
  );
  assert.equal(
    fileStatus(makeRecord([{ change: "added", status: "reviewed" }], ["pending"])),
    "inReview",
  );
  assert.equal(
    fileStatus(
      makeRecord(
        [{ change: "added", status: "reviewed" }],
        ["reviewed"],
      ),
    ),
    "reviewed",
  );
  assert.deepEqual(
    reviewCounts(
      makeRecord(
        [
          { change: "unchanged", status: "reviewed" },
          { change: "added", status: "reviewed" },
        ],
        ["pending"],
      ),
    ),
    { reviewed: 1, total: 2 },
  );
});

test("reviewableLines skips unchanged lines", () => {
  const file = makeRecord(
    [
      { change: "unchanged", status: "reviewed" },
      { change: "added", status: "pending" },
    ],
    ["pending"],
  );
  assert.equal(reviewableLines(file).length, 2);
});

test("buildDiffRecords marks identical content unchanged without hunks", () => {
  const content = bytes("a\nb\n");
  const diff = buildDiffRecords(content, content, []);
  assert.deepEqual(diff.hunks, []);
  assert.deepEqual(diff.deletedLines, []);
  assert.ok(
    diff.currentLines.every(
      (line) => line.changeType === "unchanged" && line.reviewStatus === "reviewed",
    ),
  );
  assert.equal(
    diff.currentLines[0]?.digest,
    baselineLineDigest(bytes("a\n"), 1),
  );
});

test("buildDiffRecords represents a replacement as one addition plus one deletion", () => {
  const diff = buildDiffRecords(bytes("a\nb\n"), bytes("a\nc\n"), [
    { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
  ]);
  assert.deepEqual(
    diff.currentLines.map((line) => line.changeType),
    ["unchanged", "added"],
  );
  assert.deepEqual(
    diff.deletedLines.map((line) => line.baselineLine),
    [2],
  );
  assert.equal(
    diff.deletedLines[0]?.digest,
    baselineLineDigest(bytes("b\n"), 2),
  );
});

test("buildDiffRecords numbers duplicate additions by occurrence", () => {
  const diff = buildDiffRecords(new Uint8Array(), bytes("x\nx\n"), [
    { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
  ]);
  assert.deepEqual(
    diff.currentLines.map((line) => line.occurrence),
    [1, 2],
  );
  assert.equal(diff.currentLines[0]?.digest, diff.currentLines[1]?.digest);
});

test("buildDiffRecords transfers decisions only when duplicate counts agree", () => {
  const baseline = new Uint8Array();
  const two = bytes("x\nx\n");
  const initial = buildDiffRecords(baseline, two, [
    { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
  ]);
  const reviewer = { name: "R", time: frozenTime };
  const previous: FileRecord = {
    ...makeRecord([], []),
    ...initial,
    currentLines: initial.currentLines.map((line) => ({
      ...line,
      reviewStatus: "reviewed" as const,
      lastReviewer: reviewer,
    })),
  };
  const same = buildDiffRecords(
    baseline,
    two,
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }],
    previous,
  );
  assert.ok(
    same.currentLines.every((line) => line.reviewStatus === "reviewed"),
  );
  const grown = buildDiffRecords(
    baseline,
    bytes("x\nx\nx\n"),
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 }],
    previous,
  );
  assert.ok(
    grown.currentLines.every((line) => line.reviewStatus === "pending"),
  );
});

test("buildDiffRecords transfers deletions by digest and baseline line", () => {
  const baseline = bytes("a\nb\nc\n");
  const current = bytes("a\nc\n");
  const hunks = [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 0 }];
  const initial = buildDiffRecords(baseline, current, hunks);
  const reviewer = { name: "R", time: frozenTime };
  const previous: FileRecord = {
    ...makeRecord([], []),
    ...initial,
    deletedLines: initial.deletedLines.map((line) => ({
      ...line,
      reviewStatus: "reviewed" as const,
      lastReviewer: reviewer,
    })),
  };
  const same = buildDiffRecords(baseline, current, hunks, previous);
  assert.equal(same.deletedLines[0]?.reviewStatus, "reviewed");
  const shifted = buildDiffRecords(bytes("b\na\nc\n"), current, [
    { oldStart: 1, oldCount: 1, newStart: 2, newCount: 0 },
  ], previous);
  assert.equal(shifted.deletedLines[0]?.reviewStatus, "pending");
});

test("buildDiffRecords rebuilds a restored line as unchanged", () => {
  const baseline = bytes("a\nb\n");
  const removed = buildDiffRecords(baseline, bytes("a\n"), [
    { oldStart: 2, oldCount: 1, newStart: 2, newCount: 0 },
  ]);
  const previous: FileRecord = {
    ...makeRecord([], []),
    ...removed,
    deletedLines: removed.deletedLines.map((line) => ({
      ...line,
      reviewStatus: "reviewed" as const,
      lastReviewer: { name: "R", time: frozenTime },
    })),
  };
  const restored = buildDiffRecords(baseline, baseline, [], previous);
  assert.deepEqual(restored.deletedLines, []);
  assert.ok(
    restored.currentLines.every((line) => line.changeType === "unchanged"),
  );
});

test("setReviewer clears pending and requires identity otherwise", () => {
  assert.equal(
    setReviewer("pending", { name: "R" }, frozenTime),
    undefined,
  );
  assert.deepEqual(setReviewer("inReview", { name: "R" }, frozenTime), {
    name: "R",
    time: frozenTime,
  });
  assert.deepEqual(
    setReviewer("reviewed", { name: "R", email: "r@x.test" }, frozenTime),
    { name: "R", email: "r@x.test", time: frozenTime },
  );
  assert.throws(() => setReviewer("reviewed", undefined, frozenTime));
});

test("terminalPayload labels single lines and ranges with escalated fences", () => {
  const payload = terminalPayload("src/a.ts", "one\ntwo\nthree", [
    { start: 0, end: 0 },
  ]);
  assert.match(payload, /> Line 1, file src\/a\.ts:/);
  assert.match(payload, /```\none\n```/);
  const ranged = terminalPayload("src/a.ts", "one\ntwo\nthree", [
    { start: 0, end: 2 },
  ]);
  assert.match(ranged, /> Line 1 - 2, file src\/a\.ts:/);
  const fenced = terminalPayload("src/a.ts", "before\n```\nafter", [
    { start: 0, end: 3 },
  ]);
  assert.match(fenced, /````\nbefore\n```\nafter\n````/);
});
