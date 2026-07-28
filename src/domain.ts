import { createHash } from 'node:crypto';

export type ReviewStatus = 'pending' | 'inReview' | 'reviewed';
export type ChangeType = 'unchanged' | 'added';

export interface Reviewer {
    readonly name: string;
    readonly email?: string;
}

export interface LastReviewer {
    readonly name: string;
    readonly email?: string;
    readonly time: string;
}

export interface SourceSnapshot {
    readonly modifiedAt: number;
    readonly size: number;
}

export interface BaselineDescriptor {
    readonly file: string;
    readonly digest: string;
    readonly codec: 'gzip';
    readonly size: number;
    readonly createdAt: string;
}

export interface CurrentDescriptor extends SourceSnapshot {
    readonly digest: string;
    readonly gitAlgorithm: 'myers';
    readonly generatedAt: string;
}

export interface CurrentLineRecord {
    readonly line: number;
    readonly digest: string;
    readonly changeType: ChangeType;
    readonly reviewStatus: ReviewStatus;
    readonly occurrence: number;
    readonly lastReviewer?: LastReviewer | undefined;
}

export interface DeletedLineRecord {
    readonly baselineLine: number;
    readonly digest: string;
    readonly occurrence: number;
    readonly changeType: 'deleted';
    readonly reviewStatus: ReviewStatus;
    readonly lastReviewer?: LastReviewer | undefined;
}

export interface DiffHunk {
    readonly oldStart: number;
    readonly oldCount: number;
    readonly newStart: number;
    readonly newCount: number;
}

export interface FileRecord {
    readonly baseline: BaselineDescriptor;
    readonly current: CurrentDescriptor;
    readonly fileStatus: ReviewStatus;
    readonly lastReviewTime?: string | undefined;
    readonly currentLines: readonly CurrentLineRecord[];
    readonly deletedLines: readonly DeletedLineRecord[];
    readonly hunks: readonly DiffHunk[];
    readonly nextRevExtId: number;
    readonly updatedAt: string;
}

export interface PhysicalLine {
    readonly digest: string;
    readonly bytes: Uint8Array;
}

export interface RawGitHunk {
    readonly oldStart: number;
    readonly oldCount: number;
    readonly newStart: number;
    readonly newCount: number;
}

export const digestBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Splits exact bytes into editor-visible physical lines while retaining LF/CRLF identity. */
export function physicalLines(bytes: Uint8Array): readonly PhysicalLine[] {
    const decoder = new TextDecoder('utf-8', { fatal: true });
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

export function reviewableLines(
    file: Pick<FileRecord, 'currentLines' | 'deletedLines'>
): readonly (CurrentLineRecord | DeletedLineRecord)[] {
    return [
        ...file.currentLines.filter(line => line.changeType !== 'unchanged'),
        ...file.deletedLines
    ];
}

export function fileStatus(file: Pick<FileRecord, 'currentLines' | 'deletedLines'>): ReviewStatus {
    const changed = reviewableLines(file);
    if (changed.length === 0 || changed.every(line => line.reviewStatus === 'reviewed')) {
        return 'reviewed';
    }
    if (changed.some(line => line.reviewStatus !== 'pending')) {
        return 'inReview';
    }
    return 'pending';
}

export function reviewCounts(file: Pick<FileRecord, 'currentLines' | 'deletedLines'>): {
    reviewed: number;
    total: number;
} {
    const changed = reviewableLines(file);
    return { reviewed: changed.filter(line => line.reviewStatus === 'reviewed').length, total: changed.length };
}

export function buildDiffRecords(
    baselineBytes: Uint8Array,
    currentBytes: Uint8Array,
    rawHunks: readonly RawGitHunk[],
    previous?: FileRecord
): Pick<FileRecord, 'currentLines' | 'deletedLines' | 'hunks'> {
    const baseline = physicalLines(baselineBytes);
    const current = physicalLines(currentBytes);
    const previousCurrent = groupByDigest(previous?.currentLines.filter(line => line.changeType === 'added') ?? []);
    const previousDeleted = new Map(
        (previous?.deletedLines ?? []).map(line => [`${line.digest}:${line.baselineLine}`, line])
    );
    const currentOccurrences = occurrences(current.map(line => line.digest));
    const currentChangeOccurrences = new Map<string, number>();
    const deletionOccurrences = new Map<string, number>();
    const nextAdditionCounts = changedDigestCounts(current, rawHunks);
    const currentLines: CurrentLineRecord[] = [];
    const deletedLines: DeletedLineRecord[] = [];
    const hunks: DiffHunk[] = [];
    let oldCursor = 1;
    let newCursor = 1;

    for (const raw of rawHunks) {
        const oldIndex = raw.oldCount === 0 ? raw.oldStart : raw.oldStart - 1;
        const newIndex = raw.newCount === 0 ? raw.newStart : raw.newStart - 1;
        while (oldCursor - 1 < oldIndex && newCursor - 1 < newIndex) {
            const line = current[newCursor - 1];
            if (line !== undefined) {
                currentLines.push({
                    line: newCursor,
                    digest: baselineLineDigest(baseline[oldCursor - 1]!.bytes, oldCursor),
                    changeType: 'unchanged',
                    occurrence: currentOccurrences[newCursor - 1] ?? 1, reviewStatus: 'reviewed'
                });
            }
            oldCursor += 1;
            newCursor += 1;
        }

        const oldLines = baseline.slice(oldIndex, oldIndex + raw.oldCount);
        const newLines = current.slice(newIndex, newIndex + raw.newCount);

        for (let index = 0; index < newLines.length; index += 1) {
            const newNumber = raw.newStart + index;
            const occurrence = nextOccurrence(currentChangeOccurrences, newLines[index]!.digest);
            const transferred = transferAddition(
                previousCurrent,
                nextAdditionCounts,
                newLines[index]!.digest,
                occurrence
            );
            currentLines.push({
                line: newNumber, digest: newLines[index]!.digest, changeType: 'added',
                reviewStatus: transferred?.reviewStatus ?? 'pending',
                occurrence,
                lastReviewer: transferred?.lastReviewer
            });
        }

        for (let index = 0; index < oldLines.length; index += 1) {
            const oldNumber = raw.oldStart + index;
            const digest = baselineLineDigest(oldLines[index]!.bytes, oldNumber);
            const occurrence = nextOccurrence(deletionOccurrences, digest);
            const transferred = previousDeleted.get(`${digest}:${oldNumber}`);
            deletedLines.push({
                baselineLine: oldNumber, digest,
                occurrence, changeType: 'deleted',
                reviewStatus: transferred?.reviewStatus ?? 'pending',
                lastReviewer: transferred?.lastReviewer
            });
        }
        hunks.push(raw);
        oldCursor = oldIndex + raw.oldCount + 1;
        newCursor = newIndex + raw.newCount + 1;
    }

    while (newCursor <= current.length) {
        currentLines.push({
            line: newCursor,
            digest: baselineLineDigest(baseline[oldCursor - 1]!.bytes, oldCursor),
            changeType: 'unchanged',
            occurrence: currentOccurrences[newCursor - 1] ?? 1, reviewStatus: 'reviewed'
        });
        oldCursor += 1;
        newCursor += 1;
    }

    currentLines.sort((a, b) => a.line - b.line);
    return { currentLines, deletedLines, hunks };
}

/** The NUL separator is unambiguous because tracked source files reject NUL bytes. */
export function baselineLineDigest(line: Uint8Array, lineNumber: number): string {
    return digestBytes(new Uint8Array([...line, 0, ...new TextEncoder().encode(String(lineNumber))]));
}

export function setReviewer(
    status: ReviewStatus,
    reviewer: Reviewer | undefined,
    at: string
): LastReviewer | undefined {
    if (status === 'pending') {
        return undefined;
    }
    if (reviewer === undefined) {
        throw new Error('A reviewer is required for non-pending decisions');
    }
    return reviewer.email === undefined
        ? { name: reviewer.name, time: at }
        : { name: reviewer.name, email: reviewer.email, time: at };
}

function occurrences(digests: readonly string[]): readonly number[] {
    const seen = new Map<string, number>();
    return digests.map(digest => {
        const next = (seen.get(digest) ?? 0) + 1;
        seen.set(digest, next);
        return next;
    });
}

function groupByDigest<T extends {
    digest: string;
}>(records: readonly T[]): ReadonlyMap<string, readonly T[]> {
    const result = new Map<string, T[]>();
    for (const record of records) {
        const matching = result.get(record.digest) ?? [];
        matching.push(record);
        result.set(record.digest, matching);
    }
    return result;
}

function changedDigestCounts(
    lines: readonly PhysicalLine[],
    hunks: readonly RawGitHunk[]
): ReadonlyMap<string, number> {
    const result = new Map<string, number>();
    for (const hunk of hunks) {
        if (hunk.newCount === 0) {
            continue;
        }
        for (const line of lines.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.newCount)) {
            result.set(line.digest, (result.get(line.digest) ?? 0) + 1);
        }
    }
    return result;
}

function transferAddition(
    previous: ReadonlyMap<string, readonly CurrentLineRecord[]>,
    nextCounts: ReadonlyMap<string, number>,
    digest: string,
    occurrence: number
): CurrentLineRecord | undefined {
    const matching = previous.get(digest);
    if (matching === undefined || matching.length !== nextCounts.get(digest)) {
        return undefined;
    }
    return matching[occurrence - 1];
}

function nextOccurrence(seen: Map<string, number>, digest: string): number {
    const value = (seen.get(digest) ?? 0) + 1;
    seen.set(digest, value);
    return value;
}

export function terminalPayload(path: string, text: string, ranges: readonly {
    start: number;
    end: number;
}[]): string {
    const source = text.split(/\r?\n/);
    const blocks = ranges.map(range => {
        const last = range.end > range.start && range.end < source.length ? range.end - 1 : range.end;
        const firstOneBased = range.start + 1;
        const lastOneBased = Math.max(firstOneBased, last + 1);
        const label = firstOneBased === lastOneBased ? `${firstOneBased}` : `${firstOneBased} - ${lastOneBased}`;
        const content = source.slice(range.start, last + 1).join('\n');
        const backticks = Math.max(3, ...(content.match(/`+/g) ?? []).map(run => run.length + 1));
        const fence = '`'.repeat(backticks);
        return `> Line ${label}, file ${path}:\n${fence}\n${content}\n${fence}\n`;
    });
    return `${blocks.join('\n')}\n`;
}
