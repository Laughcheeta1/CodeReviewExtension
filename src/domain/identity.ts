import { createHash } from "node:crypto";
import type { PhysicalLine } from "./types";


export const digestBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Splits exact bytes into editor-visible physical lines while retaining LF/CRLF identity. */
export function physicalLines(bytes: Uint8Array): readonly PhysicalLine[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  decoder.decode(bytes);
  const result: PhysicalLine[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) {
      continue;
    }
    const line = bytes.slice(start, index + 1);
    result.push({ digest: digestBytes(line), bytes: line });
    start = index + 1;
  }
  if (start < bytes.length) {
    const line = bytes.slice(start);
    result.push({ digest: digestBytes(line), bytes: line });
  }
  return result;
}

/** Return whether a physical line contains only its LF/CRLF terminator. */
export function isEmptyPhysicalLine(bytes: Uint8Array): boolean {
  if (bytes.at(-1) !== 0x0a) {
    return false;
  }
  return bytes.length === 1 ||
    (bytes.length === 2 && bytes[0] === 0x0d);
}

/** The NUL separator is unambiguous because tracked source files reject NUL bytes. */
export function baselineLineDigest(
  line: Uint8Array,
  lineNumber: number,
): string {
  return digestBytes(
    new Uint8Array([
      ...line,
      0,
      ...new TextEncoder().encode(String(lineNumber)),
    ]),
  );
}
