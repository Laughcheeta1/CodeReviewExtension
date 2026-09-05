/**
 * Backwards-compatible entry point for command handlers.
 *
 * Diff viewing, reviewer resolution, mark actions, and workspace commands
 * live in focused modules; this barrel preserves the historical
 * `./review-commands` import path.
 */
export {
  closePromotedDiffTabs,
  openDocumentInReviewView,
  openReviewDiff,
} from "./review-commands/diff-view";
export { resolveReviewer } from "./review-commands/reviewer-flow";
export { markActive, markFile, markFolder } from "./review-commands/mark";
export { initializeAll, sendSelection } from "./review-commands/workspace";
