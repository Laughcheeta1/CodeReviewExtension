/**
 * Backwards-compatible entry point for persisted review metadata.
 *
 * Naming, record construction, validation, and schema checks live in
 * focused modules; this barrel preserves the historical
 * `./storage-format` import path used across the extension and tests.
 */
export type { FileSummary, StoredFile } from "./storage-format/record";
export {
  folderHash,
  pathHash,
  snapshotFileName,
  storageFileName,
} from "./storage-format/naming";
export {
  sourceMayHaveChanged,
  storedFile,
  summarize,
} from "./storage-format/record";
export { describeStoredFileProblem, parseStoredFile } from "./storage-format/schema";
