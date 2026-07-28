import { createHash } from 'node:crypto';
import {
    fileStatus,
    reviewCounts,
    type FileRecord,
    type LastReviewer,
    type ReviewStatus,
    type SourceSnapshot
} from './domain';

export interface StoredFile {
    readonly schemaVersion: 4;
    readonly path: string;
    readonly file: FileRecord;
}
export interface FileSummary {
    readonly status: ReviewStatus;
    readonly reviewed: number;
    readonly total: number;
    readonly source: SourceSnapshot;
    readonly baselineFile: string;
}
export function pathHash(path: string): string {
    return createHash('sha256').update(path).digest('hex');
}

export function storageFileName(path: string): string {
    return `${pathHash(path)}.json`;
}

export function snapshotFileName(path: string, digest: string): string {
    return `${pathHash(path)}.${digest}.gz`;
}

export function storedFile(path: string, file: FileRecord): StoredFile {
    return {
        schemaVersion: 4,
        path,
        file: {
            ...file,
            currentLines: file.currentLines.map(({
                line,
                digest,
                changeType,
                reviewStatus,
                occurrence,
                lastReviewer
            }) => {
                const record = { line, digest, changeType, reviewStatus, occurrence };
                return lastReviewer === undefined ? record : { ...record, lastReviewer };
            }),
            hunks: file.hunks.map(({ oldStart, oldCount, newStart, newCount }) => ({
                oldStart, oldCount, newStart, newCount
            }))
        }
    };
}
export function summarize(file: FileRecord): FileSummary {
    return {
        status: fileStatus(file), ...reviewCounts(file),
        source: { modifiedAt: file.current.modifiedAt, size: file.current.size },
        baselineFile: file.baseline.file
    };
}
export function sourceMayHaveChanged(
    modifiedAt: number,
    size: number,
    source: SourceSnapshot | undefined
): boolean {
    return source === undefined || modifiedAt !== source.modifiedAt || size !== source.size;
}
export function parseStoredFile(value: unknown): StoredFile | undefined {
    if (
        !isObject(value)
        || value.schemaVersion !== 4
        || !isRelativePath(value.path)
        || !isFileRecord(value.file)
    ) {
        return undefined;
    }
    if (!isConsistent(value.path, value.file)) {
        return undefined;
    }
    return { schemaVersion: 4, path: value.path, file: value.file };
}
function isFileRecord(value: unknown): value is FileRecord {
    if (!isObject(value) || !isTimestamp(value.updatedAt) || !isReviewStatus(value.fileStatus)
        || (value.lastReviewTime !== undefined && !isTimestamp(value.lastReviewTime))
        || !isBaseline(value.baseline) || !isCurrent(value.current) || !positiveInteger(value.nextRevExtId)
        || !Array.isArray(value.currentLines) || !Array.isArray(value.deletedLines) || !Array.isArray(value.hunks)) {
        return false;
    }
    return value.currentLines.every(line => isObject(line)
        && positiveInteger(line.line) && isDigest(line.digest)
        && (line.changeType === 'unchanged' || line.changeType === 'added')
        && isReviewStatus(line.reviewStatus)
        && positiveInteger(line.occurrence)
        && (line.lastReviewer === undefined || isLastReviewer(line.lastReviewer)))
        && value.deletedLines.every(line => isObject(line) && line.changeType === 'deleted'
            && positiveInteger(line.baselineLine) && isDigest(line.digest) && isReviewStatus(line.reviewStatus)
        && positiveInteger(line.occurrence)
        && (line.lastReviewer === undefined || isLastReviewer(line.lastReviewer)))
        && value.hunks.every(hunk =>
            isObject(hunk)
            && nonNegativeInteger(hunk.oldCount)
            && validRangeStart(hunk.oldStart, hunk.oldCount)
            && nonNegativeInteger(hunk.newCount) && validRangeStart(hunk.newStart, hunk.newCount)
            && (hunk.oldCount > 0 || hunk.newCount > 0));
}
function isBaseline(value: unknown): boolean {
    return isObject(value) && typeof value.file === 'string' && isDigest(value.digest) && value.codec === 'gzip'
        && isTimestamp(value.createdAt)
        && nonNegativeInteger(value.size);
}
function isCurrent(value: unknown): boolean {
    return isObject(value) && isDigest(value.digest) && value.gitAlgorithm === 'myers' && isTimestamp(value.generatedAt)
        && finiteNumber(value.modifiedAt) && nonNegativeInteger(value.size);
}
function isLastReviewer(value: unknown): value is LastReviewer {
    return isObject(value) && typeof value.name === 'string'
        && (value.email === undefined || typeof value.email === 'string')
        && isTimestamp(value.time);
}
function isConsistent(path: string, file: FileRecord): boolean {
    if (file.baseline.file !== snapshotFileName(path, file.baseline.digest)) {
        return false;
    }
    if (file.fileStatus !== fileStatus(file)) {
        return false;
    }
    if (!file.currentLines.every((line, index) =>
        line.line === index + 1
        && decisionMatches(line.reviewStatus, line.lastReviewer, line.changeType === 'unchanged')
    )) {
        return false;
    }
    if (!file.deletedLines.every(line => decisionMatches(line.reviewStatus, line.lastReviewer, false))) {
        return false;
    }
    const additions = new Set(file.currentLines.filter(line => line.changeType === 'added').map(line => line.line));
    const deletions = new Set(file.deletedLines.map(line => line.baselineLine));
    if (deletions.size !== file.deletedLines.length) {
        return false;
    }
    const hunkAdditions = new Set<number>();
    const hunkDeletions = new Set<number>();
    for (const hunk of file.hunks) {
        if (!addRange(hunkAdditions, hunk.newStart, hunk.newCount)
            || !addRange(hunkDeletions, hunk.oldStart, hunk.oldCount)) {
            return false;
        }
    }
    return sameValues(additions, hunkAdditions) && sameValues(deletions, hunkDeletions);
}
function decisionMatches(status: ReviewStatus, lastReviewer: LastReviewer | undefined, unchanged: boolean): boolean {
    if (unchanged) {
        return status === 'reviewed' && lastReviewer === undefined;
    }
    if (status === 'pending') {
        return lastReviewer === undefined;
    }
    return lastReviewer !== undefined;
}
function isReviewStatus(value: unknown): boolean {
    return value === 'pending' || value === 'inReview' || value === 'reviewed';
}
function isDigest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function isTimestamp(value: unknown): value is string {
    return typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        && Number.isFinite(Date.parse(value));
}
function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
    return finiteNumber(value) && Number.isInteger(value) && value >= 0;
}
function positiveInteger(value: unknown): value is number { return nonNegativeInteger(value) && value > 0; }
function validRangeStart(start: unknown, count: unknown): boolean {
    return positiveInteger(start) || (start === 0 && count === 0);
}
function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
function isRelativePath(value: unknown): value is string {
    if (
        typeof value !== 'string'
        || value.length === 0
        || value.startsWith('/')
        || value.includes('\\')
        || value.includes('\0')
    ) {
        return false;
    }
    return value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}
function addRange(lines: Set<number>, start: number, count: number): boolean {
    for (let line = start; line < start + count; line += 1) {
        if (lines.has(line)) {
            return false;
        }
        lines.add(line);
    }
    return true;
}
function sameValues(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
    return left.size === right.size && [...left].every(value => right.has(value));
}
