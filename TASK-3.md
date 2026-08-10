# Task overview

Add an opt-in review setting that automatically accepts deletions of physical
lines containing only a line ending, so formatter-driven blank-line cleanup
does not create review work or remain as tracked deletion metadata.

# Goals

- Add `codeReviewTracker.ignoreEmptyLineDeletions`, disabled by default for
  backward-compatible behavior.
- Apply the setting at the shared diff/reconciliation boundary so save,
  filesystem watcher, refresh, startup, and review paths behave identically.
- Keep v4 metadata valid by removing ignored deletions from both deleted-line
  records and effective hunk ranges.
- Promote a file automatically when its only effective changes are ignored
  empty-line deletions, making the accepted current bytes the new baseline.
- Preserve non-empty deletions, additions, exact byte identity, ignore guards,
  duplicate-marker behavior, and existing review transfer semantics.
- Add unit and Extension Host coverage for default behavior, enabled behavior,
  mixed diffs, save/watcher reconciliation, configuration changes, persistence,
  restart, and snapshot cleanup.

# Implementation details

1. Reconcile the approved design with `ARCHITECTURE.md` and preserve the
   existing uncommitted changes from `TASK-2.md` and the working tree.
2. Extend the pure domain diff builder with an option for ignoring old-side
   lines whose physical content is empty after removing the LF/CRLF terminator.
   Keep whitespace-only lines reviewable, matching the current documentation
   distinction. Track ignored baseline line numbers while building records.
3. Derive effective hunk ranges from the retained additions and deletions when
   filtering is enabled. Split ranges around ignored old lines so the storage
   consistency validator still sees an exact cover of persisted reviewable
   line numbers. Preserve raw hunk output when the setting is disabled.
4. Read the setting per source/workspace in `ReviewService`, pass it through
   every existing recomputation path, and add a configuration-change refresh
   that forces policy reconciliation for affected tracked sources. A setting
   change must not bypass final eligibility or per-source serialization.
5. When an enabled recomputation produces no effective changes while the
   baseline and current digests differ, accept the result by promoting the
   current bytes to the baseline. Mixed changes retain the old baseline until
   their remaining reviewable lines are reviewed; the ignored deletion stays
   absent from metadata and is included naturally when normal promotion occurs.
6. Add the manifest setting and update `README.md` and `ARCHITECTURE.md` to
   describe the persisted-data authority, strict empty-line definition,
   effective hunk behavior, automatic acceptance, mixed-change behavior, and
   configuration refresh semantics. No metadata schema bump is needed.
7. Add unit tests for strict empty lines, CRLF, whitespace-only lines,
   default-disabled behavior, filtered hunk consistency, and retained mixed
   changes. Add integration coverage that reads metadata and gzip snapshots
   after save and external-file reconciliation, verifies the setting toggle,
   and confirms the result survives restart without orphan snapshots.
8. Run focused tests, type checking, linting, browser and integration suites,
   then the aggregate `pnpm test`. Since source and manifest files change,
   increment the extension version, synchronize `src/extension.ts`, package a
   VSIX, and inspect its embedded manifest and artifact name.

# Kanban List

- [Done] Inspect `ARCHITECTURE.md`, the existing task, and dirty-tree scope.
- [Done] Implement the domain filtering and effective hunk generation.
- [Done] Wire configuration, forced refresh, and automatic acceptance.
- [Done] Add tests and update architecture/user documentation.
- [Done] Run verification, synchronize the version, and inspect the VSIX.

# Findings

- The storage validator requires persisted hunk deletion ranges to exactly
  cover `deletedLines`, so filtering only the line records would make metadata
  unreadable. Effective hunk generation is required.
- The existing README distinguishes lines containing only a line ending from
  whitespace-only lines; the implementation will preserve that distinction.
- Keeping an old baseline for a deletion-only ignored change would leave a
  stale snapshot despite showing no reviewable work. Automatic promotion is
  therefore part of acceptance for the deletion-only case.
- Mixed diffs cannot partially rewrite the exact reviewed baseline without
  accepting other changes. They will retain the baseline, omit only the
  ignored deletion from review metadata, and promote normally after remaining
  changes are reviewed.
- Unit, browser, lint, type-check, and full Extension Host integration suites
  passed. The aggregate `pnpm test` also passed.
- Version `0.5.18` is synchronized between `package.json` and
  `src/extension.ts`; the packaged artifact is
  `code-review-tracker-0.5.18.vsix`, whose embedded manifest reports `0.5.18`
  and the new configuration property.
