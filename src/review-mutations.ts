/**
 * Backwards-compatible entry point for review state mutations.
 *
 * Pending initialization, freshness checks, review commits, and promotion
 * live in focused modules; this barrel preserves the historical
 * `./review-mutations` import path.
 */
export type {
  BaselineIdentity,
  ReviewMutationContext,
} from "./review-mutations/context";
export { initializePendingFile } from "./review-mutations/pending";
export { requireFresh } from "./review-mutations/fresh";
export { applyReview, commitReview } from "./review-mutations/review";
export { promote } from "./review-mutations/promote";
