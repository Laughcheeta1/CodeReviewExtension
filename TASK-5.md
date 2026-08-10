# Task overview

Restore RevExt identity-comment insertion when a tracked source changes through
the host filesystem, such as a coding agent writing the file, while preserving
the existing external diff reconciliation and native review-diff behavior.

# Goals

- Add a bulletproof Extension Host regression covering a real host filesystem
  write with duplicate added lines, persisted diff metadata, RevExt comments,
  and native diff availability.
- Ensure external reconciliation annotates duplicate added lines through the
  same safe pipeline as ordinary saved-document reconciliation.
- Keep saved disk bytes authoritative and never overwrite unrelated dirty
  editor-buffer content during an external write.
- Preserve baseline immutability, review-transfer behavior, internal-save
  recursion guards, ignore eligibility guards, and serialized per-source
  operations described by `ARCHITECTURE.md`.
- Run focused and full verification, synchronize the extension version, and
  package/inspect a new VSIX after the source change.

# Implementation details

1. Preserve the pre-existing dirty worktree and use `TASK-5.md` as the task
   record; do not reset or overwrite `TASK-4.md` or unrelated user changes.
2. Reuse the existing `revext-annotation.ts` save reconciliation algorithm for
   external watcher events rather than creating a second marker implementation.
   The external path must calculate the diff from stable host bytes, annotate
   only duplicate added lines that need identity, save the marker edits through
   the existing `internalSaves` guard, reread the marked bytes, and commit
   metadata whose current digest matches the actual persisted file.
3. If an external event races with a dirty editor buffer, keep the architecture
   boundary intact: reconcile the saved host bytes without applying marker
   edits to or saving the dirty editor document. For a clean already-loaded
   document, use its language-aware marker placement; for an unopened source,
   use a safe source-document path only as needed to determine language and
   apply edits without changing the saved-content authority.
4. Extend the integration fixture with a TypeScript source that begins from a
   promoted reviewed baseline, receives duplicate additions via direct host
   filesystem I/O, and has no manual `document.save()` in that scenario. Assert
   that metadata changed, the two added records remain pending, the persisted
   current digest matches the marked physical bytes, exactly two `// RevExt:`
   markers exist only on the duplicate additions, and the native review diff
   still opens with a baseline URI and the source URI. Include an open-diff
   external-write assertion where it materially strengthens the reported
   coding-agent scenario.
5. Re-audit every changed lifecycle path against ignore/disabled guards and the
   architecture's baseline/current digest rules. Run focused unit/integration
   checks, type checking, linting, browser tests, and the complete integration
   suite as available in the environment.
6. Increment the manifest version and every runtime version identifier, build a
   VSIX with `pnpm`, and inspect its filename and embedded manifest version.

# Kanban List

- [Done] Obtain the independent full test-suite audit.
- [Done] Read architecture, inspect the dirty worktree, and trace the external
  watcher, diff, save, and RevExt paths.
- [Done] Add the external duplicate-marker regression test.
- [Done] Share the annotation pipeline with external reconciliation while
  preserving dirty-buffer safety.
- [Done] Run focused and complete verification.
- [Done] Synchronize versions and package/inspect the VSIX.

# Findings

- The independent audit found broad coverage for startup, persistence, ignore
  rules, external changes, dirty buffers, native diffs, stale selections,
  lifecycle events, restart cleanup, reviewer identity, RevExt syntax, and
  JSX validity.
- The concrete gap is that `ReviewService.reconcileExternalSource` calls the
  generic `recompute` path, which calculates Git diff records but never invokes
  RevExt annotation. The save path alone calls
  `recomputeSavedDocument` in `revext-annotation.ts`.
- Existing external-write coverage uses unique additions, so it proves diff
  persistence but cannot fail when duplicate additions are left unmarked.
  Existing marker coverage reaches the annotation path through
  `TextDocument.save()` and therefore does not represent a coding-agent host
  write.
- The implementation must account for the architecture's explicit dirty
  editor boundary: host bytes are reviewable, but a dirty buffer must not be
  silently overwritten by external reconciliation.
- The audit's local unit/lint/browser checks passed; the integration suite was
  inconclusive because Chromium/VS Code launch did not produce a completed
  suite result in the restricted environment. An elevated rerun after the fix
  completed the contract, restart, and disabled suites successfully.
- The first elevated rerun exposed that annotating a host write while a dirty
  editor buffer was open caused the later editor save to fail with `File
  Modified Since`. Dirty external sources now use the existing raw
  reconciliation path; clean sources use stable-byte annotation and preserve
  the saved-content authority.
- Version `0.5.20` is synchronized between `package.json` and
  `src/extension.ts`. The packaged artifact is
  `code-review-tracker-0.5.20.vsix`; its embedded manifest and package report
  `0.5.20`.
