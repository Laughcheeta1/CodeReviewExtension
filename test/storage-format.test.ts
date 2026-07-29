import assert from "node:assert/strict";
import test from "node:test";
import { digestBytes, type FileRecord } from "../src/domain.ts";
import {
  parseStoredFile,
  snapshotFileName,
  sourceMayHaveChanged,
  storageFileName,
  storedFile,
  summarize,
} from "../src/storage-format.ts";
const digest = digestBytes(new TextEncoder().encode("value"));
const file: FileRecord = {
  baseline: {
    file: snapshotFileName("src/a.ts", digest),
    digest,  // RevExt: 1
    codec: "gzip",
    size: 5,  // RevExt: 3
    createdAt: "2026-07-27T11:00:00.000Z",
  },  // RevExt: 5
  current: {
    digest,  // RevExt: 2
    modifiedAt: 1000,
    size: 5,  // RevExt: 4
    gitAlgorithm: "myers",
    generatedAt: "2026-07-27T12:00:00.000Z",
  },  // RevExt: 6
  fileStatus: "pending",
  nextRevExtId: 2,
  currentLines: [
    {
      line: 1,
      digest,
      changeType: "added",
      reviewStatus: "pending",
      occurrence: 1,
    },
  ],
  deletedLines: [],
  hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }],
  updatedAt: "2026-07-27T12:00:00.000Z",
};
test("storage filenames are deterministic and path-safe", () => {
  assert.equal(storageFileName("src/a.ts"), storageFileName("src/a.ts"));
  assert.match(storageFileName("../outside.ts"), /^[a-f0-9]{64}\.json$/);
  assert.match(
    snapshotFileName("src/a.ts", digest),
    /^[a-f0-9]{64}\.[a-f0-9]{64}\.gz$/,
  );  // RevExt: 7
});  // RevExt: 13
test("v4 metadata round-trips and summarizes reviewable changes", () => {
  const value = storedFile("src/a.ts", file);
  assert.deepEqual(parseStoredFile(JSON.parse(JSON.stringify(value))), value);
  assert.deepEqual(summarize(file), {
    status: "pending",
    reviewed: 0,
    total: 1,
    source: { modifiedAt: 1000, size: 5 },
    baselineFile: file.baseline.file,
  });  // RevExt: 20
});  // RevExt: 14
test("older metadata is rejected rather than migrated", () => {
  assert.equal(parseStoredFile({ schemaVersion: 1, files: {} }), undefined);
  assert.equal(  // RevExt: 22
    parseStoredFile({ schemaVersion: 2, path: "src/a.ts", file: {} }),
    undefined,  // RevExt: 27
  );  // RevExt: 8
  assert.equal(  // RevExt: 23
    parseStoredFile({ schemaVersion: 3, path: "src/a.ts", file: {} }),
    undefined,  // RevExt: 28
  );  // RevExt: 9
});  // RevExt: 15
test("filesystem stat gates startup recomputation", () => {
  assert.equal(  // RevExt: 24
    sourceMayHaveChanged(1000, 5, { modifiedAt: 1000, size: 5 }),
    false,
  );  // RevExt: 10
  assert.equal(  // RevExt: 25
    sourceMayHaveChanged(1001, 5, { modifiedAt: 1000, size: 5 }),
    true,  // RevExt: 29
  );  // RevExt: 11
  assert.equal(  // RevExt: 26
    sourceMayHaveChanged(1000, 6, { modifiedAt: 1000, size: 5 }),
    true,  // RevExt: 30
  );  // RevExt: 12
});  // RevExt: 16
test("malformed digests, statuses, and hunk references are rejected", () => {
  const badDigest = JSON.parse(
    JSON.stringify(storedFile("src/a.ts", file)),  // RevExt: 31
  ) as {  // RevExt: 37
    file: {  // RevExt: 43
      current: {
        digest: string;
      };
    };  // RevExt: 49
  };  // RevExt: 56
  badDigest.file.current.digest = "bad";
  assert.equal(parseStoredFile(badDigest), undefined);
  const badStatus = JSON.parse(
    JSON.stringify(storedFile("src/a.ts", file)),  // RevExt: 32
  ) as {  // RevExt: 38
    file: {  // RevExt: 44
      currentLines: {
        reviewStatus: string;
      }[];  // RevExt: 63
    };  // RevExt: 50
  };  // RevExt: 57
  badStatus.file.currentLines[0]!.reviewStatus = "unknown";
  assert.equal(parseStoredFile(badStatus), undefined);
  const staleCache = JSON.parse(
    JSON.stringify(storedFile("src/a.ts", file)),  // RevExt: 33
  ) as {  // RevExt: 39
    file: {  // RevExt: 45
      fileStatus: string;
    };  // RevExt: 51
  };  // RevExt: 58
  staleCache.file.fileStatus = "reviewed";
  assert.equal(parseStoredFile(staleCache), undefined);
  const orphanAddition = JSON.parse(
    JSON.stringify(storedFile("src/a.ts", file)),  // RevExt: 34
  ) as {  // RevExt: 40
    file: {  // RevExt: 46
      hunks: unknown[];  // RevExt: 65
    };  // RevExt: 52
  };  // RevExt: 59
  orphanAddition.file.hunks = [];
  assert.equal(parseStoredFile(orphanAddition), undefined);
});  // RevExt: 17
test("stored paths must be normalized workspace-relative POSIX paths", () => {
  for (const path of [
    "",
    "/absolute.ts",
    "../outside.ts",
    "src/../outside.ts",
    "src\\a.ts",
    "src//a.ts",
    "src/\0a.ts",
  ]) {
    const matchingFile: FileRecord = {
      ...file,
      baseline: {
        ...file.baseline,
        file: snapshotFileName(path, digest),
      },
    };  // RevExt: 53
    assert.equal(parseStoredFile(storedFile(path, matchingFile)), undefined);
  }
});  // RevExt: 18
test("hunk ranges must uniquely and completely cover every addition and deletion", () => {
  const duplicateHunk = JSON.parse(
    JSON.stringify(storedFile("src/a.ts", file)),  // RevExt: 35
  ) as {  // RevExt: 41
    file: {  // RevExt: 47
      hunks: unknown[];  // RevExt: 66
    };  // RevExt: 54
  };  // RevExt: 60
  duplicateHunk.file.hunks.push({
    oldStart: 0,  // RevExt: 67
    oldCount: 0,  // RevExt: 69
    newStart: 1,
    newCount: 1,
  });  // RevExt: 21
  assert.equal(parseStoredFile(duplicateHunk), undefined);
  const emptyHunk = JSON.parse(
    JSON.stringify(storedFile("src/a.ts", file)),  // RevExt: 36
  ) as {  // RevExt: 42
    file: {  // RevExt: 48
      hunks: {
        oldStart: number;
        oldCount: number;
        newStart: number;
        newCount: number;
      }[];  // RevExt: 64
    };  // RevExt: 55
  };  // RevExt: 61
  emptyHunk.file.hunks[0] = {
    oldStart: 0,  // RevExt: 68
    oldCount: 0,  // RevExt: 70
    newStart: 0,
    newCount: 0,
  };  // RevExt: 62
  assert.equal(parseStoredFile(emptyHunk), undefined);
});  // RevExt: 19
