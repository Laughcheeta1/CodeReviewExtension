
export type ReviewStatus = "pending" | "inReview" | "reviewed";
export type ChangeType = "unchanged" | "added";

/** Author attribution supplied by the Git adapter to domain classification. */
export interface GitBlameLine {
  readonly line: number;
  readonly authorName?: string | undefined;
  readonly authorEmail?: string | undefined;
  readonly commit: string;
}

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
  /**
   * Initial status for a genuinely new added current line.
   *
   * The callback is consulted only when no stored review decision
   * transfers. Stored metadata remains authoritative; blame-derived
   * values never overwrite an already-known record. When omitted, new
   * lines stay pending.
   *
   * A non-pending status for a new line requires a reviewer to satisfy
   * persisted validation (see `initialReviewerForAddition`). Callers that
   * classify new lines as reviewed must also supply that reviewer callback;
   * otherwise the record is rejected on read as invalid v4 metadata.
   */
  readonly initialStatusForAddition?:
    | ((currentLine: number) => ReviewStatus)
    | undefined;
  /**
   * Initial reviewer for a genuinely new added current line.
   *
   * Consulted only when no stored review decision transfers and the
   * resolved status is non-pending. Pending lines never carry a reviewer.
   * The blame-based recomputation path derives this from the blamed author
   * so other-user additions persist as valid reviewed records.
   */
  readonly initialReviewerForAddition?:
    | ((currentLine: number) => LastReviewer | undefined)
    | undefined;
}
