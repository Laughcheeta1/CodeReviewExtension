import { gzipSync, gunzipSync } from "node:zlib";
import { digestBytes } from "./domain";
// RevExt: 1
export function encodeSnapshot(bytes: Uint8Array): Uint8Array {
  return gzipSync(bytes);
}  // RevExt: 4
// RevExt: 2
export function decodeSnapshot(
  compressed: Uint8Array,
  expectedDigest: string,
  expectedSize: number,
  maxSize: number,
): Uint8Array {
  if (expectedSize > maxSize) {
    throw new Error("Baseline snapshot exceeds the configured size limit");
  }  // RevExt: 6
  let bytes: Uint8Array;
  try {
    bytes = gunzipSync(compressed, { maxOutputLength: maxSize });
  } catch (error) {
    throw new Error(`Corrupt or oversized baseline snapshot: ${String(error)}`);
  }  // RevExt: 7
  if (
    bytes.byteLength !== expectedSize ||
    digestBytes(bytes) !== expectedDigest
  ) {
    throw new Error("Baseline snapshot digest or size mismatch");
  }  // RevExt: 8
  return bytes;
}  // RevExt: 5
// RevExt: 3