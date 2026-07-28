# TODO

## Discuss the quick-startup reconciliation policy

The current design avoids reading, decompressing, and Git-diffing every tracked file whenever VS Code opens. It compares each source file's current `(mtime, size)` with the filesystem checkpoint saved by its last successful reconciliation:

- Matching values skip the expensive pipeline.
- A mismatch stable-reads and hashes the file, validates the baseline, and runs Git.
- Before opening a review diff or changing review state, the exact saved-file digest is always verified even when startup skipped the file.

This is fast and prevents stale review actions. Its remaining tradeoff is that an external tool could change bytes while deliberately preserving both mtime and byte size. Startup would not discover that change until the file is saved, manually refreshed, opened for review, or acted upon. Discuss whether this delayed detection is acceptable or whether startup should hash every file for stronger certainty at greater I/O cost.

## Discuss ambiguous identical additions

Occurrence distinguishes repeated lines while their number and order remain stable. If two identical added lines have different review states and one is removed, a baseline-to-current diff cannot prove which occurrence survived because the baseline contains neither addition.

The implemented fail-safe is:

- When the count of an added digest is unchanged, transfer state by ordered occurrence.
- When that count changes, reset every surviving addition with that digest to pending.

This prevents a reviewed decision from being assigned to the wrong duplicate, but can require harmless repeat review. Discuss whether this conservative behavior is preferable or whether the extension should store additional identity—such as another compressed previous-current snapshot or stable record IDs plus a second diff—at the cost of more storage and complexity.

Deleted duplicates do not need this fallback because an exact baseline line number identifies each deleted occurrence.

## Discuss file renames

The tracker intentionally performs no rename inference. A missing old path is removed with its metadata/snapshot, and a newly discovered path receives an empty baseline and becomes added/pending. This never carries review state to the wrong file, but a pure rename requires review again.

Discuss whether preserving state across renames is valuable enough to justify explicit rename detection. Any future solution must avoid Git-history or multi-author synchronization and must verify exact content digests before transferring state.

## Review workspace-file exclusions

Eligible files are found from the workspace, not from Git's index, so untracked saved files are covered. The extension currently excludes its tracker directory, `.git`, and `node_modules`, and then applies binary/UTF-8/size validation.

Discuss whether projects need configurable exclusion globs for generated output, dependency trees with different names, build artifacts, or very large monorepos. The safe current behavior is to skip unsupported files without modifying existing review state.

## Discuss an initialization marker for empty workspaces

Initialization is currently represented by the existence of at least one valid per-file metadata record. An empty workspace—or a workspace where every discovered file is binary, oversized, or invalid UTF-8—cannot create such a record, so the initialization prompt returns on the next activation.

Discuss whether this rare case needs one small workspace-level marker. Adding it would eliminate the repeated prompt, but it would also introduce a second kind of persisted state beside the intentionally per-file model.

## Discuss dynamic multi-root workspace changes

Workspace folders are registered when the extension activates. Adding or removing a folder from a multi-root workspace later requires reloading the window before that folder receives its store, watcher, reconciliation, and initialization prompt.

Discuss whether hot-added workspace folders are common enough to justify a folder lifecycle controller. The current static activation model is smaller and does not affect ordinary single-folder use.

## Expand failure-path Extension Host coverage

The implementation now serializes operations per source, prevents initialization from racing active source operations, preserves malformed metadata instead of replacing it, recovers after a failed queued write, and removes failed atomic-write temporary files. Add fault-injection tests for those persistence boundaries if the project introduces a VS Code filesystem test double; the current real Extension Host smoke test verifies activation and command registration but cannot cheaply inject individual filesystem failures.
