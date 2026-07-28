import { gzipSync, gunzipSync } from 'node:zlib';
import { digestBytes } from './domain';
export function encodeSnapshot(bytes: Uint8Array): Uint8Array {
    return gzipSync(bytes);
}
export function decodeSnapshot(compressed: Uint8Array, expectedDigest: string, expectedSize: number, maxSize: number): Uint8Array {
    if (expectedSize > maxSize) {
        throw new Error('Baseline snapshot exceeds the configured size limit');
    }
    let bytes: Uint8Array;
    try {
        bytes = gunzipSync(compressed, { maxOutputLength: maxSize });
    } catch (error) {
        throw new Error(`Corrupt or oversized baseline snapshot: ${String(error)}`);
    }
    if (bytes.byteLength !== expectedSize || digestBytes(bytes) !== expectedDigest) {
        throw new Error('Baseline snapshot digest or size mismatch');
    }
    return bytes;
}

