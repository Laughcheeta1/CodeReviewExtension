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
    },  // RevExt: 1
    current: {
      digest: digestBytes(currentBytes),
      modifiedAt: 1,
      size: currentBytes.byteLength,
      gitAlgorithm: "myers",
      generatedAt: "now",
    },  // RevExt: 2
    fileStatus: fileStatus(diff),
    nextRevExtId: 1,
    ...diff,
    updatedAt: "now",
  };  // RevExt: 3
}
test("physical lines include blank lines and line-ending identity", () => {
  const lines = physicalLines(bytes("one\r\n\r\nthree"));
  assert.equal(lines.length, 3);
  assert.equal(lines[1]?.digest, digestBytes(bytes("\r\n")));
  assert.notEqual(lines[0]?.digest, physicalLines(bytes("one\n"))[0]?.digest);
  assert.notEqual(lines[2]?.digest, physicalLines(bytes("three\n"))[0]?.digest);
});  // RevExt: 10
test("baseline identities include their immutable line number", () => {
  const line = bytes("same\n");
  assert.notEqual(baselineLineDigest(line, 1), baselineLineDigest(line, 2));
});  // RevExt: 11
test("replacement is represented as independent deletion and addition", () => {
  const result = buildDiffRecords(bytes("old\n"), bytes("new\n"), [
    { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },  // RevExt: 25
  ]);  // RevExt: 27
  assert.deepEqual(  // RevExt: 41
    result.currentLines.map((line) => line.changeType),
    ["added"],
  );  // RevExt: 48
  assert.equal(result.deletedLines.length, 1);
  assert.deepEqual(result.hunks[0], {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
  });
  assert.equal(fileStatus(result as FileRecord), "pending");  // RevExt: 64
});  // RevExt: 12
test("unchanged ranges are filled around additions and deletions", () => {
  const result = buildDiffRecords(bytes("a\nb\nc\n"), bytes("a\nx\nc\n"), [
    { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
  ]);  // RevExt: 28
  assert.deepEqual(  // RevExt: 42
    result.currentLines.map((line) => [line.line, line.changeType]),  // RevExt: 66
    [  // RevExt: 70
      [1, "unchanged"],  // RevExt: 74
      [2, "added"],  // RevExt: 77
      [3, "unchanged"],  // RevExt: 80
    ],  // RevExt: 82
  );  // RevExt: 49
  assert.equal(result.currentLines[0]?.reviewStatus, "reviewed");
  assert.equal(result.deletedLines[0]?.baselineLine, 2);  // RevExt: 86
});  // RevExt: 13
test("deleting all content produces deletion records without phantom current lines", () => {
  const result = buildDiffRecords(bytes("one\n\n"), new Uint8Array(), [
    { oldStart: 1, oldCount: 2, newStart: 0, newCount: 0 },
  ]);  // RevExt: 29
  assert.equal(result.currentLines.length, 0);
  assert.deepEqual(  // RevExt: 43
    result.deletedLines.map((line) => line.baselineLine),  // RevExt: 88
    [1, 2],  // RevExt: 90
  );  // RevExt: 50
});  // RevExt: 14
test("newline-only additions and deletions retain their physical lines", () => {
  const result = buildDiffRecords(bytes("before\n\n"), bytes("after\n\n"), [
    { oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 },
  ]);  // RevExt: 30
  assert.deepEqual(  // RevExt: 44
    result.currentLines.map((line) => [line.line, line.changeType]),  // RevExt: 67
    [  // RevExt: 71
      [1, "added"],
      [2, "added"],  // RevExt: 78
    ],  // RevExt: 83
  );  // RevExt: 51
  assert.deepEqual(  // RevExt: 45
    result.deletedLines.map((line) => line.baselineLine),  // RevExt: 89
    [1, 2],  // RevExt: 91
  );  // RevExt: 52
  assert.equal(fileStatus(result as FileRecord), "pending");  // RevExt: 65
// RevExt: 92
  const blankOnly = buildDiffRecords(new Uint8Array(), bytes("\r\n"), [
    { oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 },  // RevExt: 94
  ]);  // RevExt: 31
  assert.equal(blankOnly.currentLines.length, 1);
  assert.equal(blankOnly.deletedLines.length, 0);
  assert.equal(fileStatus(blankOnly as FileRecord), "pending");
  assert.deepEqual(reviewCounts(blankOnly as FileRecord), { reviewed: 0, total: 1 });
});  // RevExt: 15
test("zero-count insertion hunk preserves unchanged lines before and after it", () => {
  const result = buildDiffRecords(bytes("a\nc\n"), bytes("a\nb\nc\n"), [
    { oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 },  // RevExt: 96
  ]);  // RevExt: 32
  assert.deepEqual(  // RevExt: 46
    result.currentLines.map((line) => [line.line, line.changeType]),  // RevExt: 68
    [  // RevExt: 72
      [1, "unchanged"],  // RevExt: 75
      [2, "added"],  // RevExt: 79
      [3, "unchanged"],  // RevExt: 81
    ],  // RevExt: 84
  );  // RevExt: 53
});  // RevExt: 16
test("zero-count deletion hunk preserves unchanged lines around the deletion", () => {
  const result = buildDiffRecords(bytes("a\nb\nc\n"), bytes("a\nc\n"), [
    { oldStart: 2, oldCount: 1, newStart: 1, newCount: 0 },
  ]);  // RevExt: 33
  assert.deepEqual(  // RevExt: 47
    result.currentLines.map((line) => [line.line, line.changeType]),  // RevExt: 69
    [  // RevExt: 73
      [1, "unchanged"],  // RevExt: 76
      [2, "unchanged"],
    ],  // RevExt: 85
  );  // RevExt: 54
  assert.equal(result.deletedLines[0]?.baselineLine, 2);  // RevExt: 87
});  // RevExt: 17
test("addition review state transfers by digest and occurrence when duplicate cardinality is stable", () => {
  const initial = buildDiffRecords(new Uint8Array(), bytes("same\nsame\n"), [  // RevExt: 98
    { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },  // RevExt: 100
  ]);  // RevExt: 34
  const previous = {
    ...record("", "same\nsame\n", [  // RevExt: 102
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },  // RevExt: 104
    ]),  // RevExt: 106
    currentLines: initial.currentLines.map((line, index) =>  // RevExt: 108
      index === 0  // RevExt: 110
        ? {  // RevExt: 112
            ...line,  // RevExt: 115
            reviewStatus: "reviewed" as const,
            lastReviewer: { name: "Ada", time: "now" },  // RevExt: 119
          }  // RevExt: 123
        : {
            ...line,  // RevExt: 116
            reviewStatus: "inReview" as const,
            lastReviewer: { name: "Ada", time: "now" },  // RevExt: 120
          },
    ),  // RevExt: 126
  };  // RevExt: 4
  const next = buildDiffRecords(  // RevExt: 130
    new Uint8Array(),  // RevExt: 132
    bytes("same\nsame\n"),
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }],
    previous,  // RevExt: 134
  );  // RevExt: 55
  assert.equal(next.currentLines[0]?.reviewStatus, "reviewed");
  assert.equal(next.currentLines[1]?.reviewStatus, "inReview");
});  // RevExt: 18
test("ambiguous duplicate additions reset pending when their cardinality changes", () => {
  const initial = buildDiffRecords(new Uint8Array(), bytes("same\nsame\n"), [  // RevExt: 99
    { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },  // RevExt: 101
  ]);  // RevExt: 35
  const previous: FileRecord = {
    ...record("", "same\nsame\n", [  // RevExt: 103
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },  // RevExt: 105
    ]),  // RevExt: 107
    currentLines: initial.currentLines.map((line, index) =>  // RevExt: 109
      index === 0  // RevExt: 111
        ? {  // RevExt: 113
            ...line,  // RevExt: 117
            reviewStatus: "reviewed",  // RevExt: 136
            lastReviewer: { name: "Ada", time: "now" },  // RevExt: 121
          }  // RevExt: 124
        : line,  // RevExt: 138
    ),  // RevExt: 127
  };  // RevExt: 5
  const next = buildDiffRecords(  // RevExt: 131
    new Uint8Array(),  // RevExt: 133
    bytes("same\n"),
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }],
    previous,  // RevExt: 135
  );  // RevExt: 56
  assert.equal(next.currentLines[0]?.reviewStatus, "pending");
  assert.equal(next.currentLines[0]?.lastReviewer, undefined);
});  // RevExt: 19
test("reviewed additions survive line movement but edited additions reset pending", () => {
  const initial = record("a\nb\n", "x\na\nb\n", [
    { oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 },  // RevExt: 95
  ]);  // RevExt: 36
  const reviewed: FileRecord = {  // RevExt: 140
    ...initial,
    currentLines: initial.currentLines.map((line) =>
      line.changeType === "added"
        ? {  // RevExt: 114
            ...line,  // RevExt: 118
            reviewStatus: "reviewed",  // RevExt: 137
            lastReviewer: { name: "Ada", time: "now" },  // RevExt: 122
          }  // RevExt: 125
        : line,  // RevExt: 139
    ),  // RevExt: 128
  };  // RevExt: 6
  const moved = buildDiffRecords(
    bytes("a\nb\n"),  // RevExt: 142
    bytes("a\nx\nb\n"),
    [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 }],  // RevExt: 144
    reviewed,  // RevExt: 146
  );  // RevExt: 57
  assert.equal(moved.currentLines[1]?.reviewStatus, "reviewed");
  const edited = buildDiffRecords(
    bytes("a\nb\n"),  // RevExt: 143
    bytes("a\ny\nb\n"),
    [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 }],  // RevExt: 145
    reviewed,  // RevExt: 147
  );  // RevExt: 58
  assert.equal(edited.currentLines[1]?.reviewStatus, "pending");
});  // RevExt: 20
test("removed additions disappear and restored deletions become unchanged", () => {
  const added = record("a\n", "a\nx\n", [
    { oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 },  // RevExt: 97
  ]);  // RevExt: 37
  const withoutAddition = buildDiffRecords(
    bytes("a\n"),  // RevExt: 148
    bytes("a\n"),  // RevExt: 149
    [],  // RevExt: 150
    added,
  );  // RevExt: 59
  assert.equal(
    withoutAddition.currentLines.some((line) => line.changeType === "added"),
    false,
  );  // RevExt: 60
  const deleted = record("gone\nkeep\n", "keep\n", [
    { oldStart: 1, oldCount: 1, newStart: 0, newCount: 0 },
  ]);  // RevExt: 38
  const reviewedDeletion: FileRecord = {
    ...deleted,
    deletedLines: deleted.deletedLines.map((line) => ({
      ...line,  // RevExt: 152
      reviewStatus: "reviewed",  // RevExt: 155
      lastReviewer: { name: "Ada", time: "now" },  // RevExt: 158
    })),  // RevExt: 161
  };  // RevExt: 7
  const stillDeleted = buildDiffRecords(
    bytes("gone\nkeep\n"),  // RevExt: 164
    bytes("keep\n"),
    [{ oldStart: 1, oldCount: 1, newStart: 0, newCount: 0 }],
    reviewedDeletion,  // RevExt: 167
  );  // RevExt: 61
  assert.equal(stillDeleted.deletedLines[0]?.reviewStatus, "reviewed");
  const restored = buildDiffRecords(
    bytes("gone\nkeep\n"),  // RevExt: 165
    bytes("gone\nkeep\n"),  // RevExt: 166
    [],  // RevExt: 151
    reviewedDeletion,  // RevExt: 168
  );  // RevExt: 62
  assert.equal(restored.deletedLines.length, 0);
  assert.ok(
    restored.currentLines.every(
      (line) =>
        line.changeType === "unchanged" && line.reviewStatus === "reviewed",
    ),  // RevExt: 129
  );  // RevExt: 63
});  // RevExt: 21
test("file status and counts are derived from reviewable additions and deletions", () => {
  const pending = record("old\n", "new\n", [
    { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },  // RevExt: 26
  ]);  // RevExt: 39
  const mixed: FileRecord = {
    ...pending,
    currentLines: pending.currentLines.map((line) => ({
      ...line,  // RevExt: 153
      reviewStatus: "reviewed",  // RevExt: 156
      lastReviewer: { name: "Ada", time: "now" },  // RevExt: 159
    })),  // RevExt: 162
  };  // RevExt: 8
  assert.equal(fileStatus(mixed), "inReview");
  assert.deepEqual(reviewCounts(mixed), { reviewed: 1, total: 2 });
  const reviewed: FileRecord = {  // RevExt: 141
    ...mixed,
    deletedLines: mixed.deletedLines.map((line) => ({
      ...line,  // RevExt: 154
      reviewStatus: "reviewed",  // RevExt: 157
      lastReviewer: { name: "Ada", time: "now" },  // RevExt: 160
    })),  // RevExt: 163
  };  // RevExt: 9
  assert.equal(fileStatus(reviewed), "reviewed");
});  // RevExt: 22
test("invalid UTF-8 is rejected", () => {
  assert.throws(() => physicalLines(Uint8Array.of(0xc3, 0x28)));
});  // RevExt: 23
test("terminal context supports multiple ranges", () => {
  const payload = terminalPayload("src/example.ts", "one\ntwo\nthree", [
    { start: 0, end: 2 },
    { start: 2, end: 2 },
  ]);  // RevExt: 40
  assert.match(payload, /> Line 1 - 2, file src\/example.ts:/);
  assert.match(payload, /> Line 3, file src\/example.ts:/);
});  // RevExt: 24
test("terminal context includes a selection ending on the final line", () => {
  const payload = terminalPayload("src/example.ts", "one\ntwo\nthree", [
    { start: 0, end: 3 },
  ]);
  assert.match(payload, /> Line 1 - 3, file src\/example.ts:/);
  assert.match(payload, /one\ntwo\nthree/);
});
// RevExt: 93
