import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiffRecords,
  digestBytes,
  fileStatus,
} from "../src/domain.ts";
import {
  parseStoredFile,
  pathHash,
  snapshotFileName,
  sourceMayHaveChanged,
  storageFileName,
  storedFile,
  summarize,
  type StoredFile,
} from "../src/storage-format.ts";
// RevExt: 57
const encoder = new TextEncoder();
const frozenTime = "2026-03-01T12:00:00.000Z";
const path = "src/example.ts";
// RevExt: 58
function validStored(): StoredFile {
  const baseline = encoder.encode("a\nb\n");
  const current = encoder.encode("a\nc\n");
  const diff = buildDiffRecords(baseline, current, [
    { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
  ]);
  const baselineDigest = digestBytes(baseline);
  return storedFile(path, {
    baseline: {
      file: snapshotFileName(path, baselineDigest),
      digest: baselineDigest,
      codec: "gzip",
      size: baseline.byteLength,
      createdAt: frozenTime,
    },  // RevExt: 1
    current: {
      digest: digestBytes(current),
      modifiedAt: 7,
      size: current.byteLength,
      gitAlgorithm: "myers",
      generatedAt: frozenTime,
    },  // RevExt: 2
    fileStatus: fileStatus(diff),
    ...diff,
    nextRevExtId: 1,
    updatedAt: frozenTime,
  });
}
// RevExt: 59
test("path hashing and file naming are deterministic", () => {
  assert.match(pathHash(path), /^[a-f0-9]{64}$/);
  assert.equal(pathHash(path), pathHash(path));
  assert.notEqual(pathHash("src/a.ts"), pathHash("src/b.ts"));
  assert.equal(storageFileName(path), `${pathHash(path)}.json`);
  const digest = digestBytes(encoder.encode("x"));
  assert.equal(
    snapshotFileName(path, digest),
    `${pathHash(path)}.${digest}.gz`,
  );  // RevExt: 9
});
// RevExt: 60
test("a stored record round-trips through the parser", () => {
  const stored = validStored();
  const persisted = JSON.parse(JSON.stringify(stored)) as StoredFile;
  assert.deepEqual(parseStoredFile(persisted), persisted);
});
// RevExt: 61
test("summarize derives status, counts, stat, and snapshot name", () => {
  const stored = validStored();
  const summary = summarize(stored.file);
  assert.equal(summary.status, "pending");
  assert.equal(summary.total, 2);
  assert.equal(summary.reviewed, 0);
  assert.deepEqual(summary.source, { modifiedAt: 7, size: stored.file.current.size });
  assert.equal(summary.baselineFile, stored.file.baseline.file);
});
// RevExt: 62
test("sourceMayHaveChanged compares only the stat pair", () => {
  const stored = validStored();
  assert.equal(sourceMayHaveChanged(1, 1, undefined), true);
  assert.equal(
    sourceMayHaveChanged(
      stored.file.current.modifiedAt,
      stored.file.current.size,
      stored.file.current,
    ),
    false,
  );  // RevExt: 10
  assert.equal(
    sourceMayHaveChanged(
      stored.file.current.modifiedAt + 1,
      stored.file.current.size,
      stored.file.current,
    ),
    true,
  );  // RevExt: 11
  assert.equal(
    sourceMayHaveChanged(
      stored.file.current.modifiedAt,
      stored.file.current.size + 1,
      stored.file.current,
    ),
    true,
  );  // RevExt: 12
});
// RevExt: 63
test("the parser rejects malformed or inconsistent metadata", () => {
  assert.equal(parseStoredFile(undefined), undefined);
  assert.equal(parseStoredFile([]), undefined);
  assert.equal(parseStoredFile({ ...validStored(), schemaVersion: 3 }), undefined);
  assert.equal(
    parseStoredFile({ ...validStored(), path: "/absolute.ts" }),
    undefined,
  );  // RevExt: 13
  assert.equal(
    parseStoredFile({ ...validStored(), path: "a/../b.ts" }),
    undefined,
  );  // RevExt: 14
  const base = validStored();  // RevExt: 73
  const badDigest: StoredFile = {
    ...base,  // RevExt: 74
    file: {  // RevExt: 75
      ...base.file,  // RevExt: 76
      currentLines: base.file.currentLines.map((line, index) =>  // RevExt: 77
        index === 0 ? { ...line, digest: "not-a-digest" } : line,
      ),  // RevExt: 79
    },  // RevExt: 72
  };  // RevExt: 15
  assert.equal(parseStoredFile(badDigest), undefined);
});
// RevExt: 64
test("the parser rejects records whose derived status disagrees", () => {
  const base = validStored();  // RevExt: 24
  const stored: StoredFile = {
    ...base,  // RevExt: 27
    file: { ...base.file, fileStatus: "reviewed" },
  };  // RevExt: 16
  assert.equal(parseStoredFile(stored), undefined);
});
// RevExt: 65
test("the parser rejects reviewer and line-number inconsistencies", () => {
  const base = validStored();  // RevExt: 25
  const added = base.file.currentLines.find(
    (line) => line.changeType === "added",
  )!;
  const pendingWithReviewer: StoredFile = {
    ...base,  // RevExt: 28
    file: {  // RevExt: 35
      ...base.file,  // RevExt: 41
      currentLines: base.file.currentLines.map((line) =>  // RevExt: 47
        line === added
          ? { ...line, lastReviewer: { name: "R", time: frozenTime } }
          : line,  // RevExt: 50
      ),  // RevExt: 53
    },  // RevExt: 3
  };  // RevExt: 17
  assert.equal(parseStoredFile(pendingWithReviewer), undefined);
// RevExt: 66
  const reviewedWithoutReviewer: StoredFile = {
    ...base,  // RevExt: 29
    file: {  // RevExt: 36
      ...base.file,  // RevExt: 42
      fileStatus: "reviewed",
      currentLines: base.file.currentLines.map((line) =>  // RevExt: 48
        line.changeType === "added"
          ? { ...line, reviewStatus: "reviewed" }
          : line,  // RevExt: 51
      ),  // RevExt: 54
      deletedLines: base.file.deletedLines.map((line) => ({
        ...line,
        reviewStatus: "reviewed" as const,
      })),
    },  // RevExt: 4
  };  // RevExt: 18
  assert.equal(parseStoredFile(reviewedWithoutReviewer), undefined);
// RevExt: 67
  const sparseLines: StoredFile = {
    ...base,  // RevExt: 30
    file: {  // RevExt: 37
      ...base.file,  // RevExt: 43
      currentLines: base.file.currentLines.map((line, index) =>  // RevExt: 78
        index === 1 ? { ...line, line: 99 } : line,
      ),  // RevExt: 55
    },  // RevExt: 5
  };  // RevExt: 19
  assert.equal(parseStoredFile(sparseLines), undefined);
// RevExt: 68
  const pendingUnchanged: StoredFile = {
    ...base,  // RevExt: 31
    file: {  // RevExt: 38
      ...base.file,  // RevExt: 44
      currentLines: base.file.currentLines.map((line) =>  // RevExt: 49
        line.changeType === "unchanged"
          ? { ...line, reviewStatus: "pending" as const }
          : line,  // RevExt: 52
      ),  // RevExt: 56
    },  // RevExt: 6
  };  // RevExt: 20
  assert.equal(parseStoredFile(pendingUnchanged), undefined);
});
// RevExt: 69
test("the parser rejects hunk and snapshot-name mismatches", () => {
  const base = validStored();  // RevExt: 26
  const droppedHunks: StoredFile = {
    ...base,  // RevExt: 32
    file: { ...base.file, hunks: [] },
  };  // RevExt: 21
  assert.equal(parseStoredFile(droppedHunks), undefined);
// RevExt: 70
  const renamedSnapshot: StoredFile = {
    ...base,  // RevExt: 33
    file: {  // RevExt: 39
      ...base.file,  // RevExt: 45
      baseline: { ...base.file.baseline, file: "other.gz" },
    },  // RevExt: 7
  };  // RevExt: 22
  assert.equal(parseStoredFile(renamedSnapshot), undefined);
// RevExt: 71
  const firstDeleted = base.file.deletedLines[0]!;
  const duplicateDeletions: StoredFile = {
    ...base,  // RevExt: 34
    file: {  // RevExt: 40
      ...base.file,  // RevExt: 46
      deletedLines: [firstDeleted, { ...firstDeleted }],
      hunks: [
        {
          oldStart: firstDeleted.baselineLine,
          oldCount: 2,
          newStart: 2,
          newCount: 1,
        },
      ],
    },  // RevExt: 8
  };  // RevExt: 23
  assert.equal(parseStoredFile(duplicateDeletions), undefined);
});
