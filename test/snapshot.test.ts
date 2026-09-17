import assert from "node:assert/strict";
import test from "node:test";
import { digestBytes } from "../src/domain.ts";
import { decodeSnapshot, encodeSnapshot } from "../src/snapshot.ts";

const encoder = new TextEncoder();

test("snapshots round-trip through gzip with digest verification", () => {
  const content = encoder.encode("hello\nworld\n");
  const compressed = encodeSnapshot(content);
  const decoded = decodeSnapshot(
    compressed,
    digestBytes(content),
    content.byteLength,
    1048576,
  );
  assert.deepEqual([...decoded], [...content]);
});

test("decoding rejects digest, size, corrupt, and limit violations", () => {
  const content = encoder.encode("hello\n");
  const compressed = encodeSnapshot(content);
  assert.throws(() =>
    decodeSnapshot(compressed, "a".repeat(64), content.byteLength, 1048576),
  );
  assert.throws(() =>
    decodeSnapshot(
      compressed,
      digestBytes(content),
      content.byteLength + 1,
      1048576,
    ),
  );
  assert.throws(() =>
    decodeSnapshot(new Uint8Array([1, 2, 3]), digestBytes(content), 5, 1048576),
  );
  assert.throws(() =>
    decodeSnapshot(compressed, digestBytes(content), content.byteLength, 1),
  );
  const large = encodeSnapshot(encoder.encode("a".repeat(100)));
  assert.throws(() =>
    decodeSnapshot(large, digestBytes(encoder.encode("a".repeat(100))), 50, 60),
  );
});

test("oversized baselines are rejected before decompression", () => {
  const content = encoder.encode("x");
  const compressed = encodeSnapshot(content);
  assert.throws(() =>
    decodeSnapshot(compressed, digestBytes(content), 2048, 1024),
  );
});
