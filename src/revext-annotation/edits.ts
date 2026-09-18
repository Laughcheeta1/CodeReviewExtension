import { physicalLines } from "../domain/identity";

const revExtEditsEncoder = new TextEncoder();
const revExtEditsDecoder = new TextDecoder("utf-8", { fatal: true });

export function addedLineNumbers(
  hunks: readonly { readonly newStart: number; readonly newCount: number }[],
): Set<number> {
  const addedLines = new Set<number>();
  for (const hunk of hunks) {
    for (
      let line = hunk.newStart;
      line < hunk.newStart + hunk.newCount;
      line += 1
    ) {
      addedLines.add(line);
    }
  }
  return addedLines;
}

export function sourceLines(bytes: Uint8Array): readonly string[] {
  return physicalLines(bytes).map((line) => {
    let text = revExtEditsDecoder.decode(line.bytes);
    if (text.endsWith("\n")) {
      text = text.slice(0, -1);
    }
    if (text.endsWith("\r")) {
      text = text.slice(0, -1);
    }
    return text;
  });
}

export function applyByteEdits(
  bytes: Uint8Array,
  edits: readonly { readonly line: number; readonly suffix: string }[],
): Uint8Array {
  const lines = physicalLines(bytes);
  const insertions: { readonly offset: number; readonly bytes: Uint8Array }[] = [];
  const lineOffsets: number[] = [];
  let lineOffset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    lineOffsets[index + 1] = lineOffset;
    lineOffset += lines[index]!.bytes.length;
  }
  for (const edit of edits) {
    const line = lines[edit.line - 1];
    const offset = lineOffsets[edit.line];
    if (line === undefined || offset === undefined) {
      continue;
    }
    let contentLength = line.bytes.length;
    if (line.bytes.at(-1) === 0x0a) {
      contentLength -= 1;
    }
    if (line.bytes[contentLength - 1] === 0x0d) {
      contentLength -= 1;
    }
    insertions.push({
      offset: offset + contentLength,
      bytes: revExtEditsEncoder.encode(edit.suffix),
    });
  }
  if (insertions.length === 0) {
    return bytes;
  }
  insertions.sort((left, right) => left.offset - right.offset);
  const result = new Uint8Array(
    bytes.length + insertions.reduce((total, insertion) => total + insertion.bytes.length, 0),
  );
  let sourceOffset = 0;
  let resultOffset = 0;
  for (const insertion of insertions) {
    result.set(bytes.subarray(sourceOffset, insertion.offset), resultOffset);
    resultOffset += insertion.offset - sourceOffset;
    result.set(insertion.bytes, resultOffset);
    resultOffset += insertion.bytes.length;
    sourceOffset = insertion.offset;
  }
  result.set(bytes.subarray(sourceOffset), resultOffset);
  return result;
}
