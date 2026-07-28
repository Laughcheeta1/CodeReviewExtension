import assert from 'node:assert/strict';
import test from 'node:test';
import { revExtEdits } from '../src/revext.ts';
test('only duplicate added lines receive RevExt comments', () => {
    const result = revExtEdits(['one', 'same', 'other', 'same'], new Set([1, 2, 3, 4]), 'python', 1);
    assert.deepEqual(result.edits, [
        { line: 2, suffix: '  # RevExt: 1' },
        { line: 4, suffix: '  # RevExt: 2' }
    ]);
    assert.equal(result.nextId, 3);
});
test('an existing marker is retained while a new duplicate receives an ID', () => {
    const result = revExtEdits(['same  // RevExt: 4', 'same'], new Set([1, 2]), 'typescript', 5);
    assert.deepEqual(result.edits, [{ line: 2, suffix: '  // RevExt: 5' }]);
    assert.equal(result.nextId, 6);
});
test('the next marker ID never collides with an existing marker', () => {
    const result = revExtEdits(['same  # RevExt: 9', 'same'], new Set([1, 2]), 'python', 1);
    assert.deepEqual(result.edits, [{ line: 2, suffix: '  # RevExt: 10' }]);
    assert.equal(result.nextId, 11);
});
test('unique additions and unsafe continuations remain unchanged', () => {
    assert.deepEqual(revExtEdits(['one'], new Set([1]), 'python', 1).edits, []);
    assert.deepEqual(revExtEdits(['same\\', 'same\\'], new Set([1, 2]), 'python', 1).edits, []);
});

