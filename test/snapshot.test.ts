import assert from "node:assert/strict";
import test from "node:test";
import { digestBytes } from "../src/domain.ts";
import { decodeSnapshot, encodeSnapshot } from "../src/snapshot.ts";
const bytes = new TextEncoder().encode("one\r\n\nthree");
const digest = digestBytes(bytes);
test("gzip snapshots round-trip exact bytes", () => {
  assert.deepEqual(
    [...decodeSnapshot(encodeSnapshot(bytes), digest, bytes.byteLength, 1024)],
    [...bytes],
  );  // RevExt: 1
});  // RevExt: 7
test("snapshot decoding rejects corruption, digest mismatch, size mismatch, and limits", () => {
  assert.throws(  // RevExt: 9
    () =>  // RevExt: 14
      decodeSnapshot(Uint8Array.of(1, 2, 3), digest, bytes.byteLength, 1024),
    /Corrupt/,
  );  // RevExt: 2
  assert.throws(  // RevExt: 10
    () =>  // RevExt: 15
      decodeSnapshot(
        encodeSnapshot(bytes),
        "0".repeat(64),
        bytes.byteLength,
        1024,
      ),
    /digest or size/,  // RevExt: 17
  );  // RevExt: 3
  assert.throws(  // RevExt: 11
    () =>  // RevExt: 16
      decodeSnapshot(encodeSnapshot(bytes), digest, bytes.byteLength + 1, 1024),
    /digest or size/,  // RevExt: 18
  );  // RevExt: 4
  assert.throws(  // RevExt: 12
    () => decodeSnapshot(encodeSnapshot(bytes), digest, bytes.byteLength, 2),
    /size limit/,
  );  // RevExt: 5
  assert.throws(  // RevExt: 13
    () => decodeSnapshot(encodeSnapshot(bytes), digest, 2, 2),
    /Corrupt or oversized/,
  );  // RevExt: 6
});  // RevExt: 8
