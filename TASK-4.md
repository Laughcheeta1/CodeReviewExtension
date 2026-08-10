# Task overview

Keep an already-open native review diff usable after the saved current file
changes, with particular attention to review actions on deleted lines shown on
the immutable left side.

# Goals

- Refresh the active diff's current line/hunk mapping after saved edits without
  replacing or mutating the gzip baseline shown on the left.
- Prevent normal current-file edits from causing review commands on still
  valid deleted lines to fail with a stale-diff error.
- Preserve the architecture's exact baseline/current digest authority,
  conservative review-transfer rules, duplicate-marker behavior, dirty-buffer
  boundary, and serialized per-source operations.
- Add strong unit and Extension Host coverage for left-side deleted-line
  actions across insertions, deletions, hunk movement, rapid changes, and
  genuinely changed baselines.
- Synchronize the extension version and verify a packaged VSIX after source
  changes.

# Implementation details

1. Read `ARCHITECTURE.md` and inspect the current working tree before edits.
   Trace native diff opening, the baseline content provider, document/save
   event handling, diff preparation, stale validation, and line-selection
   mapping in the shared service and command layers.
2. Identify whether the stale boundary is caused by a captured diff generation,
   an old current digest, a raw line number, or a combination. Keep the
   immutable baseline URI/content stable and make the review action resolve
   against the latest saved generation at execution time.
3. Implement the smallest shared-boundary change that refreshes open diff
   mappings after eligible saved reconciliation. Preserve dirty-editor
   rejection and reject only actions whose baseline or target can no longer be
   proven safe; do not silently apply a stale action to a different line.
4. Add unit coverage for stable deleted-line identity and current-generation
   remapping, including inserted lines before a deletion, changed hunk shape,
   removed/reintroduced targets, and baseline replacement. Add Extension Host
   coverage that opens a diff, edits/saves the right side, then invokes the
   left-side review command and verifies persisted metadata and no stale error.
5. Run focused tests, type checking, linting, browser tests, and the complete
   Extension Host integration suite. Update `ARCHITECTURE.md` only if the
   resulting live-refresh behavior changes its documented authority boundary.
6. Increment `package.json` and every runtime version identifier, package a
   VSIX, and inspect the artifact manifest and filename.

# Kanban List

- [Done] Inspect architecture, runtime paths, and test harness.
- [Done] Trace and document the stale-diff root cause.
- [Done] Implement live current-generation diff refresh.
- [Done] Add Extension Host regression tests for left-side actions, hunk
  movement, multiple current generations, and restored deleted lines.
- [Done] Update architecture and user documentation.
- [Done] Run verification, synchronize versions, and verify the VSIX.

# Findings

- `ARCHITECTURE.md` states that the left pane is a digest-addressed immutable
  baseline and that only saved current bytes are reconciled or reviewable.
- Existing version is `0.5.18`; the prior tasks establish that source changes
  require a synchronized manifest/runtime bump and VSIX verification.
- The baseline URI stores both baseline and current digests. The current digest
  is a view-generation hint, but the native diff's modified document advances
  after a save while the original URI remains open. `requireFresh` rejected
  that normal current-side drift before it could match a deleted baseline line.
- The safe authority is the latest saved `FileRecord`: a left-side action still
  requires the same baseline digest, and `applyReview` only changes a deleted
  record when its selected baseline line remains in the latest deleted-line
  set. A changed baseline continues to produce the stale-diff error.
- Native diff integration coverage must begin from a promoted reviewed
  baseline; startup-created metadata uses an empty baseline and would model
  the original content as additions rather than left-side deletions.
- The new Extension Host scenario uses explicit forced refresh after host-file
  writes to make each current generation deterministic. Existing contract
  coverage continues to verify save and watcher lifecycle reconciliation, while
  this scenario isolates the stale open-diff selection boundary.
- Type checking, linting, unit, browser, and the complete Extension Host
  integration suite pass with the live current-generation behavior.
- Version `0.5.19` is synchronized between `package.json` and
  `src/extension.ts`. The packaged artifact is
  `code-review-tracker-0.5.19.vsix`; its embedded manifest reports `0.5.19`.
