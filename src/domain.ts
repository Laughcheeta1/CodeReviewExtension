/**
 * Backwards-compatible entry point for the review domain.
 *
 * The implementation lives in focused modules; this barrel preserves the
 * historical `./domain` import path used across the extension and tests.
 */
export type {
  BaselineDescriptor,
  ChangeType,
  CurrentDescriptor,
  CurrentLineRecord,
  DeletedLineRecord,
  DiffHunk,
  DiffOptions,
  FileRecord,
  LastReviewer,
  PhysicalLine,
  RawGitHunk,
  Reviewer,
  ReviewStatus,
  SourceSnapshot,
} from "./domain/types";
export {
  baselineLineDigest,
  digestBytes,
  isEmptyPhysicalLine,
  physicalLines,
} from "./domain/identity";
export {
  fileStatus,
  reviewableLines,
  reviewCounts,
  setReviewer,
} from "./domain/status";
export { buildDiffRecords } from "./domain/diff";
export {
  newlyAddedLineNumbers,
  updateAddedLineDigests,
} from "./domain/transfer";
export { terminalPayload } from "./domain/terminal";
