/**
 * Backwards-compatible entry point for RevExt duplicate annotation flows.
 *
 * External, save, and pending annotation flows live in focused modules;
 * this barrel preserves the historical `./revext-annotation` import path.
 */
export type { RevExtAnnotationContext } from "./revext-annotation/context";
export { recomputeExternalSource } from "./revext-annotation/external";
export { recomputeSavedDocument } from "./revext-annotation/saved";
export { annotatePendingDocument } from "./revext-annotation/pending";
