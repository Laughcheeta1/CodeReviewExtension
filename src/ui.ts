/**
 * Backwards-compatible entry point for extension UI pieces.
 *
 * The baseline provider, gutter decorations, file decorations, and sidebar
 * tree live in focused modules; this barrel preserves the historical
 * `./ui` import path.
 */
export { BaselineContentProvider } from "./ui/content-provider";
export { ReviewDecorations } from "./ui/decorations";
export { ReviewFileDecorations } from "./ui/file-decorations";
export { ReviewTree } from "./ui/tree";
