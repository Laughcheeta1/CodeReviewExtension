import assert from 'node:assert/strict';
import test from 'node:test';
import { digestBytes, type FileRecord } from '../src/domain.ts';
import { parseStoredFile, snapshotFileName, sourceMayHaveChanged, storageFileName, storedFile, summarize } from '../src/storage-format.ts';
const digest = digestBytes(new TextEncoder().encode('value'));
const file: FileRecord = {
    baseline: { file: snapshotFileName('src/a.ts', digest), digest, codec: 'gzip', size: 5, createdAt: '2026-07-27T11:00:00.000Z' },
    current: { digest, modifiedAt: 1000, size: 5, gitAlgorithm: 'myers', generatedAt: '2026-07-27T12:00:00.000Z' },
    fileStatus: 'pending',
    nextRevExtId: 2,
    currentLines: [{
            line: 1, digest, changeType: 'added', reviewStatus: 'pending', occurrence: 1
        }],
    deletedLines: [],
    hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }],
    updatedAt: '2026-07-27T12:00:00.000Z'
};
test('storage filenames are deterministic and path-safe', () => {
    assert.equal(storageFileName('src/a.ts'), storageFileName('src/a.ts'));
    assert.match(storageFileName('../outside.ts'), /^[a-f0-9]{64}\.json$/);
    assert.match(snapshotFileName('src/a.ts', digest), /^[a-f0-9]{64}\.[a-f0-9]{64}\.gz$/);
});
test('v4 metadata round-trips and summarizes reviewable changes', () => {
    const value = storedFile('src/a.ts', file);
    assert.deepEqual(parseStoredFile(JSON.parse(JSON.stringify(value))), value);
    assert.deepEqual(summarize(file), {
        status: 'pending', reviewed: 0, total: 1,
        source: { modifiedAt: 1000, size: 5 }, baselineFile: file.baseline.file
    });
});
test('older metadata is rejected rather than migrated', () => {
    assert.equal(parseStoredFile({ schemaVersion: 1, files: {} }), undefined);
    assert.equal(parseStoredFile({ schemaVersion: 2, path: 'src/a.ts', file: {} }), undefined);
    assert.equal(parseStoredFile({ schemaVersion: 3, path: 'src/a.ts', file: {} }), undefined);
});
test('filesystem stat gates startup recomputation', () => {
    assert.equal(sourceMayHaveChanged(1000, 5, { modifiedAt: 1000, size: 5 }), false);
    assert.equal(sourceMayHaveChanged(1001, 5, { modifiedAt: 1000, size: 5 }), true);
    assert.equal(sourceMayHaveChanged(1000, 6, { modifiedAt: 1000, size: 5 }), true);
});
test('malformed digests, statuses, and hunk references are rejected', () => {
    const badDigest = JSON.parse(JSON.stringify(storedFile('src/a.ts', file))) as {
        file: {
            current: {
                digest: string;
            };
        };
    };
    badDigest.file.current.digest = 'bad';
    assert.equal(parseStoredFile(badDigest), undefined);
    const badStatus = JSON.parse(JSON.stringify(storedFile('src/a.ts', file))) as {
        file: {
            currentLines: {
                reviewStatus: string;
            }[];
        };
    };
    badStatus.file.currentLines[0]!.reviewStatus = 'unknown';
    assert.equal(parseStoredFile(badStatus), undefined);
    const staleCache = JSON.parse(JSON.stringify(storedFile('src/a.ts', file))) as {
        file: {
            fileStatus: string;
        };
    };
    staleCache.file.fileStatus = 'reviewed';
    assert.equal(parseStoredFile(staleCache), undefined);
    const orphanAddition = JSON.parse(JSON.stringify(storedFile('src/a.ts', file))) as {
        file: {
            hunks: unknown[];
        };
    };
    orphanAddition.file.hunks = [];
    assert.equal(parseStoredFile(orphanAddition), undefined);
});
test('stored paths must be normalized workspace-relative POSIX paths', () => {
    for (const path of ['', '/absolute.ts', '../outside.ts', 'src/../outside.ts', 'src\\a.ts', 'src//a.ts', 'src/\0a.ts']) {
        const matchingFile: FileRecord = {
            ...file,
            baseline: { ...file.baseline, file: snapshotFileName(path, digest) }
        };
        assert.equal(parseStoredFile(storedFile(path, matchingFile)), undefined);
    }
});
test('hunk ranges must uniquely and completely cover every addition and deletion', () => {
    const duplicateHunk = JSON.parse(JSON.stringify(storedFile('src/a.ts', file))) as {
        file: {
            hunks: unknown[];
        };
    };
    duplicateHunk.file.hunks.push({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 });
    assert.equal(parseStoredFile(duplicateHunk), undefined);
    const emptyHunk = JSON.parse(JSON.stringify(storedFile('src/a.ts', file))) as {
        file: {
            hunks: {
                oldStart: number;
                oldCount: number;
                newStart: number;
                newCount: number;
            }[];
        };
    };
    emptyHunk.file.hunks[0] = { oldStart: 0, oldCount: 0, newStart: 0, newCount: 0 };
    assert.equal(parseStoredFile(emptyHunk), undefined);
});

