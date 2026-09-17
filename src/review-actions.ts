/**
 * Backwards-compatible entry point for line/file/folder review actions.
 *
 * Editor, file, and folder actions live in focused modules; this barrel
 * preserves the historical `./review-actions` import path.
 */
export type { ReviewActionContext } from "./review-actions/context";
export { markEditor } from "./review-actions/editor";
export { markFile } from "./review-actions/file";
export { markFolder } from "./review-actions/folder";
