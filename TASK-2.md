# Task overview

Investigate and fix the failure where saving two exactly identical new lines
into a fully reviewed file does not add the temporary `RevExt` identity
comments required to distinguish those duplicate additions.

# Goals

- Verify that the existing duplicate-line tests exercise the real save and
  reconciliation path for a fully reviewed file.
- Add regression coverage for two identical new lines, including lines whose
  text already exists in the reviewed baseline.
- Correct the shared implementation boundary so eligible duplicate additions
  receive distinct `RevExt` comments and persisted review identity remains
  correct after the internal marker save.
- Preserve the architecture contract for saved-content authority, duplicate
  occurrence transfer, marker removal on promotion, and unsupported-language
  behavior.

# Implementation details

1. Read `ARCHITECTURE.md`, inspect the working tree, and preserve the existing
   user modification in `.vscode/code-review-tracker/initialization.json`.
2. Trace `review-service.ts`/`revext-annotation.ts`, `revext.ts`, and the
   domain transfer helpers from a VS Code save event through marker insertion,
   the internal save guard, recomputation, and persisted metadata.
3. Compare the current unit and Extension Host integration tests with the
   requested scenario. The existing integration case begins partially
   reviewed and inserts a second pair of different text, so it did not prove
   the fully reviewed-baseline contract.
4. Add regressions that start from genuinely promoted baselines: add one line
   and its equal peer on successive saves, and separately force a watcher-first
   reconciliation before the dirty document save. Assert both distinct
   comments, persisted pending metadata, and restart inventory membership.
5. Fix the shared annotation/reconciliation boundary rather than patching one
   lifecycle callback. Preserve conservative review transfer when duplicate
   counts change, select the current duplicate group for marker creation, and
   repair untagged duplicates if the watcher committed the same saved bytes
   first. Keep generated markers out of review content and bridge decisions
   across the marker-induced digest change.
6. Run focused unit/integration checks, type checking, linting, and the
   aggregate test or the closest safe subset. If the extension source changes,
   increment the manifest version, synchronize runtime version identifiers,
   package a new VSIX, and inspect its manifest as required by `AGENTS.md`.

# Kanban List

- [Done] Inspect architecture, tests, and the runtime save path.
- [Done] Add tests for the fully reviewed duplicate-line and watcher-first
  scenarios.
- [Done] Implement the duplicate-selection and save-repair fixes.
- [Done] Run focused and full verification.
- [Done] Synchronize version identifiers and verify a packaged VSIX if the
  extension source changes.

# Findings

- The architecture explicitly requires save reconciliation to annotate new
  duplicate additions and says the complete tagged line participates in
  identity transfer.
- The existing unit test named `only annotates newly added duplicate lines`
  calls `revExtEdits` directly, so it cannot prove that a VS Code save event
  reaches the annotation code or that the internal marker save persists the
  result.
- The existing integration case `marker-save-regression` starts with a
  partially reviewed file and inserts `new repeat` twice; it does not prove
  behavior for a fully reviewed baseline with two identical additions.
- `newlyAddedLineNumbers` previously treated every duplicate-count change as
  unannotatable. That left a first persisted duplicate and its later equal
  peer without identity comments even though review transfer correctly needed
  to remain pending/ambiguous.
- A filesystem watcher can persist the same saved bytes before the document
  save callback. The save path must repair untagged duplicate additions when
  its loaded record already has the saved digest; per-source serialization
  alone does not impose lifecycle-event ordering.
- The corrected Extension Host regression uses a genuinely promoted baseline,
  successive saves, and a dirty-document watcher-first sequence. The full
  integration suite passed after both fixes.
- Verification passed with `pnpm run check-types`, `pnpm run lint`,
  `pnpm run test:unit`, `pnpm run test:browser`, and
  `pnpm run test:integration`.
- Version `0.5.17` is synchronized between `package.json` and
  `src/extension.ts`. The packaged artifact is
  `code-review-tracker-0.5.17.vsix`; its embedded manifest reports `0.5.17`.
