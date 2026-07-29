# Code Review and Simplification Report

Date: 2026-07-27

## Scope and invariants

This review covered every extension source module, the persisted schema validator, tests, build scripts, package metadata, and architecture documentation.

The cleanup deliberately preserves these product rules:

- Git is only the required local `diff --no-index` engine. There is no pull, HEAD, commit-author, or collaborator synchronization.
- A replacement remains one deletion plus one addition. No “modified” heuristic was introduced.
- Saved disk bytes and the compressed baseline are the content authorities.
- Line identity remains the exact line-byte SHA-256 digest plus ordered occurrence where duplicate additions need disambiguation.
- `fileStatus` remains a persisted sidebar cache, but every write and parse checks it against the line decisions.
- Review decisions remain attached to exact baseline/current generations, dirty editors remain non-reviewable, and completing all changes still promotes the saved file automatically.

## Persisted model simplifications

### Removed unused current-line fields

`CurrentLineRecord.baselineLine` and `beforeDigest` were removed.

They were written for unchanged lines but never read by reconciliation, review transfer, selection mapping, decoration rendering, promotion, or validation. For an unchanged line, the old digest is necessarily the same as the resulting digest, so `beforeDigest` duplicated information. Baseline line mapping is only needed for deleted records, which still retain `baselineLine`.

Schema v4 intentionally rejects legacy metadata; this development extension requires reinitialization rather than migration.

### Derived hunk membership from Git ranges

`DiffHunk.currentLines` and `deletedBaselineLines` were removed. With zero-context Git output, every line in `[newStart, newStart + newCount)` is an addition and every line in `[oldStart, oldStart + oldCount)` is a deletion. Storing those line numbers again increased JSON size without adding authority.

Hunk actions now use the four authoritative Git range values directly. The parser validates that the ranges uniquely and completely cover all persisted additions and deletions, so malformed, overlapping, empty, or orphaned hunk metadata is rejected.

### Reduced physical-line parsing

`PhysicalLine.bytes` and `PhysicalLine.text` were removed because production code only consumes the exact digest. UTF-8 is validated once for the complete file, then line-ending-preserving byte slices are hashed. This avoids decoding every line a second time and avoids retaining unused byte/text values.

### Centralized reviewable-line derivation

One `reviewableLines` helper now supplies file status, review counts, and promotion eligibility. This removes three copies of the “added current lines plus deleted baseline lines” rule and prevents those consumers from drifting.

### Kept intentional cached and identity fields

The review did not remove `fileStatus`, `occurrence`, `lastReviewTime`, current digest/mtime/size, deleted `changeType`, or the baseline descriptor. Each has an agreed pipeline purpose. In particular, the status cache is still normalized before every write and validated during every read.

## Reconciliation and persistence safeguards

### Serialized complete operations, not only writes

The store already serialized writes per path, but two asynchronous VS Code events could both read the same generation, compute different successors, and then commit in sequence. The later commit could overwrite a decision made by the first.

The service now serializes the full read/recompute/review/promote/delete operation per source URI. Workspace initialization blocks new operations for that folder and waits for active source operations before resetting the store. This preserves the same pipeline while removing a lost-update race.

### Prevented failed queue poisoning

Previously, a rejected store write became the direct predecessor of the next queued write. Because the queue used `previous.then(...)`, the next operation was skipped automatically. The queue now observes the original failure for its caller while recovering the tail before starting the next operation.

### Preserved corrupt metadata

Invalid JSON, invalid UTF-8, unsupported structure, or a transient read error was previously cached as “missing.” A later `createMissing` reconciliation could then replace it with an empty baseline, contrary to the corruption-preservation rule.

Only a real `FileNotFound` result is now treated as missing. Other read failures are logged and propagated, so reconciliation leaves the JSON and snapshot untouched. Explicit source deletion may still remove unreadable metadata; its unknown snapshot becomes an orphan and is cleaned only after a later fully safe metadata scan.

### Cleaned temporary atomic-write files

Snapshot and JSON temporary files now use `try/finally` cleanup. Startup also removes leftover root-level metadata temporary files from a process interruption. Unreferenced snapshots are still cleaned only when every committed JSON record parses successfully.

### Tightened stored-path validation

Stored paths must now be non-empty, workspace-relative, normalized POSIX paths. Absolute paths, backslashes, empty components, NUL characters, `.` segments, and `..` traversal are rejected before a path can be resolved against a workspace.

### Tightened Git result validation

The extension now rejects these impossible or unsafe outcomes:

- Git exits unchanged while the exact input bytes differ.
- Git exits changed while the exact input bytes are equal.
- Git exits changed but produces no valid hunk header.

Git remains the sole classification engine; these checks only ensure its process result is internally usable.

### Fixed name-only Git reviewer configuration

Reviewer lookup previously used one `Promise.all` where a missing `user.email` caused a valid `user.name` to be discarded. Name and email lookups now fail independently, so a configured name works with or without an email.

### Clarified eligible workspace files

The old `tracked` naming incorrectly suggested Git-index tracking. It is now `eligiblePaths`, and the stale “Git tracked files unavailable” message was removed. Saved files under `.git`, `node_modules`, and the tracker’s own directory are rejected consistently, including newly saved files discovered after initialization.

## VS Code lifecycle and UI simplifications

### Correct resource ownership

The tree provider, file-decoration provider, and inlay-hint provider now implement `Disposable` and release their own event subscriptions and emitters. The extension context owns both the providers and their VS Code registrations.

The output channel is local to activation and is disposed exactly once by the extension context; the redundant module-global `deactivate` disposal was removed.

### Removed redundant refresh and deletion paths

Review decorations now refresh from review-state changes and visible-editor changes. Keystrokes, cursor movement, save callbacks, and refresh commands no longer trigger duplicate full-editor refreshes. VS Code decoration ranges already track unsaved edits, and saved reconciliation emits the authoritative state-change event.

Selection changes now invalidate the selection-dependent inlay hints directly instead of refreshing unrelated gutter decorations.

One filesystem watcher handles source creation and deletion, including files created outside the editor. Change watcher traffic remains disabled; saved-document reconciliation is authoritative for edits.

### Logged asynchronous event failures

Fire-and-forget event callbacks now pass through one logging helper. Rejected document-load, save-reconciliation, source-deletion, initialization-prompt, or stale-tab-close operations no longer become silent unhandled promises.

### Escaped hover content

Decoration hover text now uses `MarkdownString.appendText`, so reviewer names and timestamps are displayed literally instead of being interpreted as Markdown.

### Removed internal commands from the Command Palette

Hunk commands remain registered for CodeLens, but they are no longer contributed to the Command Palette. They require structured digest/hunk arguments and did nothing when invoked manually.

## Build and test simplifications

- Added a production-only `build` script so the integration test no longer repeats type checking through `package`.
- Removed inert TypeScript `outDir` and `sourceMap` settings; TypeScript is type-check-only and esbuild owns emitted output.
- Added syntax checks for the JavaScript/MJS Extension Host harness to the lint command.
- Removed the hard-coded version from the VSIX output script; `vsce` now derives the filename from `package.json`.
- Isolated Extension Host user data in a temporary directory and placed Chromium switches before the workspace argument.
- Excluded `REVIEW.md` and `TODO.md` from the shipped VSIX because they are development records, not runtime documentation.
- Expanded regression coverage for moved and edited accepted additions, removed additions, restored and persistent deletions, mixed file-status counts, pure add/delete Git diffs, default hunk counts, hunk topology, normalized paths, and gzip expansion limits.

## Deliberately deferred items

The review avoided broader architecture without demonstrated need:

- Hot-add/remove support for multi-root workspace folders still requires a window reload.
- Empty or all-unsupported workspaces still lack a workspace-level “initialized” marker.
- The synchronous gzip implementation remains appropriate under the default 1 MiB source cap.
- A full fault-injection filesystem harness was not added solely for this cleanup.

These are recorded in `TODO.md` with their tradeoffs. The existing quick-startup, duplicate-addition, rename, and exclusion discussions remain there as well.

## Verification

Final results:

- `npm test`: passed.
- TypeScript strict checking: passed.
- ESLint plus JS/MJS harness syntax checks: passed.
- Unit suite: 27 tests passed.
- Real VS Code 1.127 Extension Host smoke test: passed with exit code 0.
- Production esbuild bundle: passed.
- VSIX packaging: passed; the archive contained only the manifest, package metadata, license, README, runtime bundle, architecture/testing docs, and icon.
- VSIX content audit confirmed that source, tests, tracker state, `TODO.md`, `REVIEW.md`, and development configuration were excluded.

The restricted command sandbox cannot launch Electron and reports Chromium `SIGTRAP`; the Extension Host and aggregate suite passed outside that nested sandbox, where GUI processes are permitted.

Generated `dist` and `.vsix` artifacts were removed after verification so the workspace retains no compiled extension copies.
