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

const encoder = new TextEncoder();
const frozenTime = "2026-03-01T12:00:00.000Z";
const path = "src/example.ts";

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
    },
    current: {
      digest: digestBytes(current),
      modifiedAt: 7,
      size: current.byteLength,
      gitAlgorithm: "myers",
      generatedAt: frozenTime,
    },
    fileStatus: fileStatus(diff),
    ...diff,
    nextRevExtId: 1,
    updatedAt: frozenTime,
  });
}

test("path hashing and file naming are deterministic", () => {
  assert.match(pathHash(path), /^[a-f0-9]{64}$/);
  assert.equal(pathHash(path), pathHash(path));
  assert.notEqual(pathHash("src/a.ts"), pathHash("src/b.ts"));
  assert.equal(storageFileName(path), `${pathHash(path)}.json`);
  const digest = digestBytes(encoder.encode("x"));
  assert.equal(
    snapshotFileName(path, digest),
    `${pathHash(path)}.${digest}.gz`,
  );
});

test("a stored record round-trips through the parser", () => {
  const stored = validStored();
  const persisted = JSON.parse(JSON.stringify(stored)) as StoredFile;
  assert.deepEqual(parseStoredFile(persisted), persisted);
});

test("summarize derives status, counts, stat, and snapshot name", () => {
  const stored = validStored();
  const summary = summarize(stored.file);
  assert.equal(summary.status, "pending");
  assert.equal(summary.total, 2);
  assert.equal(summary.reviewed, 0);
  assert.deepEqual(summary.source, { modifiedAt: 7, size: stored.file.current.size });
  assert.equal(summary.baselineFile, stored.file.baseline.file);
});

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
  );
  assert.equal(
    sourceMayHaveChanged(
      stored.file.current.modifiedAt + 1,
      stored.file.current.size,
      stored.file.current,
    ),
    true,
  );
  assert.equal(
    sourceMayHaveChanged(
      stored.file.current.modifiedAt,
      stored.file.current.size + 1,
      stored.file.current,
    ),
    true,
  );
});

test("the parser rejects malformed or inconsistent metadata", () => {
  assert.equal(parseStoredFile(undefined), undefined);
  assert.equal(parseStoredFile([]), undefined);
  assert.equal(parseStoredFile({ ...validStored(), schemaVersion: 3 }), undefined);
  assert.equal(
    parseStoredFile({ ...validStored(), path: "/absolute.ts" }),
    undefined,
  );
  assert.equal(
    parseStoredFile({ ...validStored(), path: "a/../b.ts" }),
    undefined,
  );
  const base = validStored();
  const badDigest: StoredFile = {
    ...base,
    file: {
      ...base.file,
      currentLines: base.file.currentLines.map((line, index) =>
        index === 0 ? { ...line, digest: "not-a-digest" } : line,
      ),
    },
  };
  assert.equal(parseStoredFile(badDigest), undefined);
});

test("the parser rejects records whose derived status disagrees", () => {
  const base = validStored();
  const stored: StoredFile = {
    ...base,
    file: { ...base.file, fileStatus: "reviewed" },
  };
  assert.equal(parseStoredFile(stored), undefined);
});

test("the parser rejects reviewer and line-number inconsistencies", () => {
  const base = validStored();
  const added = base.file.currentLines.find(
    (line) => line.changeType === "added",
  )!;
  const pendingWithReviewer: StoredFile = {
    ...base,
    file: {
      ...base.file,
      currentLines: base.file.currentLines.map((line) =>
        line === added
          ? { ...line, lastReviewer: { name: "R", time: frozenTime } }
          : line,
      ),
    },
  };
  assert.equal(parseStoredFile(pendingWithReviewer), undefined);

  const reviewedWithoutReviewer: StoredFile = {
    ...base,
    file: {
      ...base.file,
      fileStatus: "reviewed",
      currentLines: base.file.currentLines.map((line) =>
        line.changeType === "added"
          ? { ...line, reviewStatus: "reviewed" }
          : line,
      ),
      deletedLines: base.file.deletedLines.map((line) => ({
        ...line,
        reviewStatus: "reviewed" as const,
      })),
    },
  };
  assert.equal(parseStoredFile(reviewedWithoutReviewer), undefined);

  const sparseLines: StoredFile = {
    ...base,
    file: {
      ...base.file,
      currentLines: base.file.currentLines.map((line, index) =>
        index === 1 ? { ...line, line: 99 } : line,
      ),
    },
  };
  assert.equal(parseStoredFile(sparseLines), undefined);

  const pendingUnchanged: StoredFile = {
    ...base,
    file: {
      ...base.file,
      currentLines: base.file.currentLines.map((line) =>
        line.changeType === "unchanged"
          ? { ...line, reviewStatus: "pending" as const }
          : line,
      ),
    },
  };
  assert.equal(parseStoredFile(pendingUnchanged), undefined);
});

test("the parser rejects hunk and snapshot-name mismatches", () => {
  const base = validStored();
  const droppedHunks: StoredFile = {
    ...base,
    file: { ...base.file, hunks: [] },
  };
  assert.equal(parseStoredFile(droppedHunks), undefined);

  const renamedSnapshot: StoredFile = {
    ...base,
    file: {
      ...base.file,
      baseline: { ...base.file.baseline, file: "other.gz" },
    },
  };
  assert.equal(parseStoredFile(renamedSnapshot), undefined);

  const firstDeleted = base.file.deletedLines[0]!;
  const duplicateDeletions: StoredFile = {
    ...base,
    file: {
      ...base.file,
      deletedLines: [firstDeleted, { ...firstDeleted }],
      hunks: [
        {
          oldStart: firstDeleted.baselineLine,
          oldCount: 2,
          newStart: 2,
          newCount: 1,
        },
      ],
    },
  };
  assert.equal(parseStoredFile(duplicateDeletions), undefined);
});
