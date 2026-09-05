import {
  fileStatus,
  reviewCounts,
  type FileRecord,
  type ReviewStatus,
  type SourceSnapshot,
} from "../domain";


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
export function storedFile(path: string, file: FileRecord): StoredFile {
  return {
    schemaVersion: 4,
    path,
    file: {
      ...file,
      currentLines: file.currentLines.map(
        ({
          line,
          digest,
          changeType,
          reviewStatus,
          occurrence,
          lastReviewer,
        }) => {
          const record = {
            line,
            digest,
            changeType,
            reviewStatus,
            occurrence,
          };
          return lastReviewer === undefined
            ? record
            : { ...record, lastReviewer };
        },
      ),
      hunks: file.hunks.map(({ oldStart, oldCount, newStart, newCount }) => ({
        oldStart,
        oldCount,
        newStart,
        newCount,
      })),
    },
  };
}
export function summarize(file: FileRecord): FileSummary {
  return {
    status: fileStatus(file),
    ...reviewCounts(file),
    source: {
      modifiedAt: file.current.modifiedAt,
      size: file.current.size,
    },
    baselineFile: file.baseline.file,
  };
}
export function sourceMayHaveChanged(
  modifiedAt: number,
  size: number,
  source: SourceSnapshot | undefined,
): boolean {
  return (
    source === undefined ||
    modifiedAt !== source.modifiedAt ||
    size !== source.size
  );
}
