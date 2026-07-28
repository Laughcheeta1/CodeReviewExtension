import assert from 'node:assert/strict';
import test from 'node:test';
import { GitService, parseGitHunks } from '../src/git.ts';
import { buildDiffRecords } from '../src/domain.ts';
test('parses zero-context Git hunk ranges including zero counts', () => {
    assert.deepEqual(parseGitHunks('@@ -1 +1 @@\n@@ -2,0 +3,2 @@\n@@ -8,4 +10,0 @@\nnot a hunk\n'), [
        { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
        { oldStart: 2, oldCount: 0, newStart: 3, newCount: 2 },
        { oldStart: 8, oldCount: 4, newStart: 10, newCount: 0 }
    ]);
});
test('required Git no-index diff handles replacement, blanks, and missing final newline', async () => {
    const hunks = await new GitService().diff(new TextEncoder().encode('a\n\nold'), new TextEncoder().encode('a\n\nnew\n'));
    assert.deepEqual(hunks, [{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 }]);
});
test('Git no-index reports unchanged content as no hunks', async () => {
    const value = new TextEncoder().encode('same\r\n');
    assert.deepEqual(await new GitService().diff(value, value), []);
});
test('Git no-index reports pure additions and pure deletions', async () => {
    const git = new GitService();
    const additions = await git.diff(new Uint8Array(), new TextEncoder().encode('one\n\ntwo\n'));
    assert.deepEqual(additions, [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 }]);
    const deletions = await git.diff(new TextEncoder().encode('one\n\ntwo\n'), new Uint8Array());
    assert.deepEqual(deletions, [{ oldStart: 1, oldCount: 3, newStart: 0, newCount: 0 }]);
});
test('Git ranges drive correct records for middle insertions and deletions', async () => {
    const git = new GitService();
    const baseline = new TextEncoder().encode('a\nb\nc\n');
    const current = new TextEncoder().encode('a\nx\nc\nd\n');
    const result = buildDiffRecords(baseline, current, await git.diff(baseline, current));
    assert.deepEqual(result.currentLines.map(line => [line.line, line.changeType]), [
        [1, 'unchanged'], [2, 'added'], [3, 'unchanged'], [4, 'added']
    ]);
    assert.deepEqual(result.deletedLines.map(line => line.baselineLine), [2]);
});

