
export type ReviewStatus = "pending" | "inReview" | "reviewed";
export type ChangeType = "unchanged" | "added";

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
  readonly codec: "gzip";
  readonly size: number;
  readonly createdAt: string;
}

export interface CurrentDescriptor extends SourceSnapshot {
  readonly digest: string;
  readonly gitAlgorithm: "myers";
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
  readonly changeType: "deleted";
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

export interface DiffOptions {
  readonly ignoreEmptyLineDeletions?: boolean;
}

