/**
 * Backwards-compatible entry point for workspace lifecycle operations.
 *
 * Dependencies, initialization, reconciliation, cleanup, and whole-folder
 * initialization live in focused modules; this barrel preserves the
 * historical `./lifecycle` import path within `review-service`.
 */
export type { LifecycleDeps } from "./lifecycle/deps";
export {
  initializeDiscoveredSources,
  initializeMissingSource,
  initializeOpenedDocument,
  initializeSource,
} from "./lifecycle/init";
export {
  reconcileCreatedSource,
  reconcileExternalChanges,
  reconcileExternalSource,
  reconcileSavedDocument,
  refreshReviewPolicy,
} from "./lifecycle/reconcile";
export {
  cleanupIgnoredSources,
  cleanupMissingSources,
} from "./lifecycle/cleanup";
export { initializeFolder } from "./lifecycle/initialize-folder";
