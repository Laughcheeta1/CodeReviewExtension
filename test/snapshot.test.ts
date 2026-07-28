import assert from 'node:assert/strict';
import test from 'node:test';
import { digestBytes } from '../src/domain.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/snapshot.ts';
const bytes = new TextEncoder().encode('one\r\n\nthree');
const digest = digestBytes(bytes);
test('gzip snapshots round-trip exact bytes', () => {
    assert.deepEqual([...decodeSnapshot(encodeSnapshot(bytes), digest, bytes.byteLength, 1024)], [...bytes]);
});
test('snapshot decoding rejects corruption, digest mismatch, size mismatch, and limits', () => {
    assert.throws(() => decodeSnapshot(Uint8Array.of(1, 2, 3), digest, bytes.byteLength, 1024), /Corrupt/);
    assert.throws(() => decodeSnapshot(encodeSnapshot(bytes), '0'.repeat(64), bytes.byteLength, 1024), /digest or size/);
    assert.throws(() => decodeSnapshot(encodeSnapshot(bytes), digest, bytes.byteLength + 1, 1024), /digest or size/);
    assert.throws(() => decodeSnapshot(encodeSnapshot(bytes), digest, bytes.byteLength, 2), /size limit/);
    assert.throws(() => decodeSnapshot(encodeSnapshot(bytes), digest, 2, 2), /Corrupt or oversized/);
});

