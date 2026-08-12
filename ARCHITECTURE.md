# Architecture

This document describes the implementation in the current working tree. The
extension is a local, saved-content review tracker; it is not a source-control
provider and it does not synchronize branches, commits, remotes, or review
decisions.

## Authorities and boundaries

- The gzip snapshot is the reviewed baseline.
- The saved file on disk is the current source. A dirty editor buffer is not
  reconciled or reviewable until it is saved.
- Local `git diff --no-index` output supplies addition/deletion hunks. Git is
  not used to read `HEAD`, stage files, or import review state.
- Local Git `user.name` and `user.email` are the first reviewer-identity
  source. A configured or prompted reviewer is the fallback. The resolved
  identity is cached per workspace in VS Code global state; only the resulting
  `LastReviewer` decision is stored in a file record.
- Workspace `.gitignore` files are read and evaluated by the extension. Git's
  global excludes, repository `.git/info/exclude`, and Git ignore configuration
  are deliberately not consulted.

Review state is meaningful only for the exact baseline and current digests in
the record. A replacement is represented as one deleted old line and one added
new line; there is no synthetic `modified` record.

## Runtime pieces

- `extension.ts` activates the extension, creates services, performs startup
  reconciliation, registers VS Code commands/providers/watchers, and connects
  saved-file and external-file events.
- `review-service.ts` is the orchestration boundary. It owns workspace stores,
  eligibility checks, reconciliation, per-source serialization, stale checks,
  and the events consumed by the UI.
- `domain.ts`, `source-io.ts`, and `git.ts` implement byte/line identity,
  stable reads, record construction, and local Git hunk calculation.
- `store.ts`, `store-io.ts`, `snapshot.ts`, `storage-format.ts`, and
  `tracking.ts` implement persisted configuration, v4 metadata, gzip
  snapshots, validation, atomic writes, cleanup, and the small detail cache.
- `git-ignore.ts`, `ignore-matcher.ts`, and `workspace-discovery.ts` enumerate
  workspace files and apply nested workspace `.gitignore` rules.
- `review-actions.ts` and `review-mutations.ts` apply line/file/folder
  decisions and promote a fully reviewed file.
- `revext.ts`, `revext-syntax.ts`, and `revext-annotation.ts` preserve
  duplicate-added-line identity with temporary source comments.
- `review-commands.ts`, `initialization-setup.ts`, and `ui.ts` provide setup,
  commands, the native diff provider, sidebar, decorations, and terminal
  integration.

## Workspace lifecycle and eligibility

On activation, each workspace folder is handled as follows:

1. `PersistentStore` loads `initialization.json` and v4 metadata summaries.
   If metadata exists without an initialization file, the store treats the
   workspace as root-tracked for compatibility, without inventing a migration.
2. Metadata for missing files is removed. Eligible paths are enumerated from
   the workspace filesystem, excluding `.git`, `node_modules`, `.vscode-test`,
   and `.vscode/code-review-tracker`.
3. Root and nested `.gitignore` files are refreshed. Ignore evaluation errors
   fail closed: the affected path is not written, and existing metadata is
   preserved when cleanup cannot be trusted.
4. When tracking is initialized, newly discovered eligible sources are
   initialized and existing eligible sources are reconciled. Normal startup
   can use the stored mtime/size shortcut; forced refresh uses a digest read.

The filesystem watcher handles file creation, deletion, and external changes.
Save events reconcile the saved document. A `.gitignore` watcher refreshes
eligibility, removes metadata that is newly ignored, and initializes newly
eligible sources. The explicit **Refresh** command performs a forced workspace
reconciliation. An external change is reconciled even when the file has no
open editor or review diff.

Document loads performed internally for language detection or marker
maintenance do not make the source visible or open its review diff. When the
user later makes that source visible, the normal automatic review-view setting
applies to that manual open.

Deletion events only hide a source from the current session. Startup checks the
filesystem and permanently removes the source's metadata and snapshot when it
is still missing. The tracker never writes metadata for its own storage files.

### Initialization and tracking configuration

`initialization.json` is schema 1 and has one of these forms:

```text
{ schemaVersion: 1, state: "disabled" }
{ schemaVersion: 1, state: "initialized", targets: [{ kind: "file" | "folder", path: string }] }
```

The first-activation setup flow offers:

- **Never Initialize**, which persists the disabled state and blocks automatic
  initialization paths.
- **Start Reviewed**, which uses each selected saved file as its baseline.
- **Start Pending**, which uses an empty baseline so every current physical
  line is an added/pending line.

The setup picker starts with all currently eligible files selected and lets the
user choose file targets. Re-running **Set Up Tracking** resets existing
tracking before writing the new selection. The two whole-workspace
initialization commands do the same with a root-folder target.

The selected targets are a seed for the current implementation, not a durable
deny-list: startup discovery and explicit open/save/command paths can call
`includeTrackingTarget` for eligible files encountered later. Ignore rules and
the disabled-state guard still gate every source JSON/snapshot write.

Target inclusion and source metadata creation are separate operations. A race
with a `.gitignore` change can therefore leave an ignored path in
`initialization.json` even though the final source eligibility check prevents
its JSON record or snapshot from being written. Later source operations still
fail the ignore guard; the target itself is not automatically rolled back.

## Content identity and diff generation

`readStableSource` reads exact bytes as fatal UTF-8 text, rejects NUL bytes,
enforces `codeReviewTracker.maxFileSizeBytes` (default 1 MiB), and compares
filesystem stats before and after the read. It retries once if the source
changes while being read. File-level `baseline.digest` and `current.digest`
are SHA-256 hex digests of the exact bytes.

`physicalLines` splits only at LF and retains each line's terminator bytes.
Therefore LF, CRLF, missing final newlines, blank lines, and whitespace-only
lines have distinct physical identities. An empty file has no physical lines.

Line records use two identity strategies:

- Unchanged and deleted baseline lines use
  `SHA-256(exact baseline line bytes + NUL + one-based baseline line number)`.
  The immutable baseline line number makes a deleted line distinguishable from
  other equal text and lets a restored line become unchanged again.
- Added current lines use the SHA-256 of their exact current physical bytes
  plus an ordered occurrence number for duplicate-transfer decisions. A
  temporary `RevExt` suffix is part of those bytes while it exists.

For different content, `GitService` writes the two byte arrays to temporary
files and runs:

```text
git diff --no-index --no-ext-diff --no-textconv --no-color --text \
  --unified=0 --diff-algorithm=myers --indent-heuristic -- baseline current
```

Exit code 0 means unchanged, 1 is a valid diff, and all other results fail.
Only zero-context hunk headers are persisted. `buildDiffRecords` rebuilds
unchanged spans, current additions, and deleted baseline lines from those
hunks; it never pairs old and new lines as a modification. When
`codeReviewTracker.ignoreEmptyLineDeletions` is enabled, a deleted baseline
line containing only its LF/CRLF terminator is omitted from the reviewable
records. Effective hunk ranges are split around those omitted lines so their
old-side ranges still exactly cover the persisted deleted records; whitespace-
only lines remain reviewable.

## Persisted state

The current layout is:

```text
.vscode/code-review-tracker/
  initialization.json
  <sha256(relative-path)>.json
  snapshots/
    <sha256(relative-path)>.<baseline-digest>.gz
```

Each metadata file is a `StoredFile` with `schemaVersion: 4`, the normalized
workspace-relative path, and a `FileRecord` containing:

- `baseline`: snapshot filename, exact digest, `gzip` codec, uncompressed
  size, and creation time;
- `current`: exact digest, filesystem mtime/size, `gitAlgorithm: "myers"`, and
  reconciliation time;
- `fileStatus`, optional `lastReviewTime`, `updatedAt`, and `nextRevExtId`;
- `currentLines`: one-based current line, digest, occurrence,
  `changeType: "unchanged" | "added"`, review status, and optional reviewer;
- `deletedLines`: baseline line, digest, occurrence, `changeType: "deleted"`,
  review status, and optional reviewer;
- `hunks`: old/new start and count ranges.

With empty-line deletion filtering enabled, `hunks` describe only effective
reviewable changes. The exact baseline snapshot and current digest remain the
authorities; the option changes which deletion records are reviewable, not the
bytes used for identity or the native diff content.

`ReviewStatus` is `pending`, `inReview`, or `reviewed`. Unchanged lines are
automatically reviewed and have no reviewer attribution. Only added and
deleted lines are reviewable. `fileStatus` and sidebar counts are derived from
those lines; the storage boundary recomputes `fileStatus` before every write
and rejects inconsistent metadata on read. `FileSummary` is a derived cache,
not another persisted record. Older or malformed schemas are ignored rather
than migrated.

## Persistence safety

Snapshots are content-addressed and verified before they become authoritative:

1. gzip bytes are written to a unique temporary snapshot;
2. the temporary bytes are read back and checked against the baseline digest,
   size, and configured decompression limit;
3. the snapshot is renamed into place without overwriting a valid target;
4. JSON is written to a unique temporary sibling and atomically renamed over
   the metadata file;
5. an old snapshot is removed only after the metadata commit succeeds.

If the JSON commit fails, the old metadata remains authoritative and the new
snapshot may remain as an orphan until a safe startup cleanup. Temporary files
are removed in `finally` blocks. Unreferenced gzip files are deleted only when
all metadata files were parsed safely. Corrupt, oversized, binary, or invalid
UTF-8 input does not replace an existing review record.

The store keeps one summary per known source and at most eight detailed records
in an LRU-style cache. Loads are coalesced and writes are serialized per path;
`ReviewService` serializes the larger source operation around them. Deleting a
record removes its JSON, referenced snapshot, summary, and cached detail.

## Reconciliation and review transfer

The common recomputation pipeline is:

1. check the current ignore and initialization boundaries;
2. load the previous record and use mtime/size only when the caller permits
   the fast path;
3. stable-read the saved source and calculate its exact digest;
4. if the digest changed, load and verify the baseline snapshot, run Git, and
   rebuild the line records, applying the configured empty-line deletion
   policy;
5. atomically commit the new generation only after the final eligibility check.

When `ignoreEmptyLineDeletions` is enabled and the effective diff contains no
reviewable changes, the current bytes are automatically promoted to the next
baseline. This removes the accepted blank deletion from both metadata and the
snapshot history. In a mixed diff, the exact old baseline remains until the
remaining additions or non-empty deletions are reviewed; only the empty
deletion is omitted from review metadata.

New additions and deletions start `pending`. Existing decisions transfer as
follows:

- A deletion matches the previous deleted record by baseline digest and exact
  baseline line number. If the old line is restored, it is rebuilt as an
  unchanged/reviewed line.
- An added line matches by exact digest and ordered added-side occurrence, but
  only when the number of equal additions is unchanged. If that count changes,
  all surviving additions with that digest become pending because the diff
  cannot prove which duplicate was removed.
- `inReview` and `reviewed` transfer together when identity is unambiguous;
  new or ambiguous records are pending.

Saved-file and clean external-file reconciliation may add identity comments to
new duplicate additions. If the duplicate count changes, review transfer
remains conservative, but the current duplicate group is still selected so a
newly duplicated line and its untagged peers receive distinct markers. A clean
external write is annotated from the stable host bytes and then rescanned so
the persisted digest includes the marker suffixes. If a file watcher commits
saved bytes before the save callback, the save path rescans the current added
lines and repairs any untagged duplicate peers. Dirty editor buffers remain a
separate boundary: external reconciliation persists the host bytes without
rewriting the dirty document, and the later save path repairs markers. Internal
saves are marked so they do not recursively reconcile themselves; review
decisions are bridged across the marker-induced digest change before the final
record is committed.

Per-source operations—save/external reconciliation, diff preparation, baseline
reads, decisions, deletion, and promotion—are serialized by `ReviewService`.
Workspace initialization waits for existing source operations and rejects new
ones while it resets the store. This prevents asynchronous VS Code events from
committing conflicting generations.

The stat pair is an optimization signal, not content authority. Startup and
ordinary diff preparation may skip a read when mtime and size match. Save and
external-file reconciliation stable-read the source, and explicit review
mutations force a digest check. Diff preparation rejects dirty source editors;
the baseline URI carries baseline/current digests and is checked when the
baseline provider or a review action consumes it. The baseline digest is a
strict authority check. The current digest identifies the saved generation
that was open when the native diff was created, but the modified side is live:
after a later saved edit, the provider and review action use the latest saved
record while retaining the same immutable baseline. A left-side action is
applied only if its selected baseline line still exists in that latest
deleted-line set. A changed baseline still rejects the action as stale. A
same-size, same-mtime rewrite can still be missed while opening or displaying
a diff because those paths use the stat shortcut; a later review mutation uses
the forced check and resolves the latest saved generation.

## RevExt duplicate markers

The marker system is enabled only for language IDs listed in
`revext-syntax.ts`; unsupported languages are left untouched. It annotates
duplicate added lines, not unique additions. Existing markers are recognized
and preserved while duplicate peers are annotated. Promotion removes generated
markers from added lines before saving the next clean baseline.

- Normal line-comment languages receive a `//`, `#`, `--`, `%`, or equivalent
  `RevExt: N` suffix according to the language map.
- JavaScript/TypeScript React documents are scanned with a small stateful
  lexer. JavaScript contexts use line comments; JSX child contexts use
  `{/* RevExt: N */}`, which is a non-rendering JSX expression comment.
- JSX tag attributes, unfinished tags, strings, comments, regular expressions,
  and other unsafe/ambiguous insertion points are skipped to preserve source
  validity. The affected duplicate remains protected by conservative
  digest/occurrence transfer.

The marker is an implementation aid, not review content: it is transparent in
the editor decoration layer, is removed on promotion, and does not become a
rendered JSX child.

## Native diff UI and commands

The `code-review-baseline:` content provider exposes a digest-addressed,
read-only baseline. The native VS Code diff editor shows that baseline on the
left and the saved file URI on the right. Left selections map to deleted lines;
right selections map to added lines. The native modified side remains live
after a saved edit, and the extension resolves left-side decorations and
actions against the latest saved record without changing the baseline. If a
previously deleted line is no longer deleted, the action becomes a no-op rather
than applying to an unrelated line. Selections containing only unchanged lines
do nothing.

When `codeReviewTracker.openFilesInReviewView` is enabled, a user-visible file
open opens the source in the native review view. Extension-owned document loads
used for reconciliation, marker placement, or promotion are kept invisible and
do not trigger that automatic review-view action.

The Code Review sidebar groups files by pending/in-review/reviewed status and
shows reviewed/total changed-line counts. Gutter decorations and hover text
show line state and the last reviewer in both panes. Explorer context actions
mark files or folders pending, in review, or reviewed; editor actions mark the
active selection, open the review diff, or send the selection to a terminal.
The default line shortcuts are Ctrl+Alt+J/K/L, and Ctrl+Alt+P sends a selection
to the agent terminal.

When every added and deleted line is reviewed, promotion stable-reads the
current file, removes `RevExt` markers, writes the current bytes as the next
baseline, clears the diff/deleted records, and closes obsolete native diff
tabs. Empty-line deletion filtering uses the same promotion boundary when a
file has no remaining effective changes. Marking a clean tracked file pending
creates an empty-baseline generation for that file without changing other
files.

Reviewer resolution is cached per workspace and follows this order: cached
identity, local Git identity, configured `reviewerName`/`reviewerEmail`, then
interactive fallback. `sendSelectionToTerminal` sends fenced, line-labeled
current editor text to the active terminal or creates a `Code Review Agent`
terminal. A configured `agentCommand` is started only when a new terminal is
created and the workspace is trusted.

Other commands are setup/reconfiguration, whole-workspace pending/reviewed
initialization, refresh, and log display. The manifest also exposes
`maxFileSizeBytes`, `ignoreEmptyLineDeletions`, and `openFilesInReviewView`.
Changing the empty-line setting forces a serialized policy reconciliation for
existing tracked sources. The extension supports local files in Restricted Mode with limited functionality, targets VS Code
`^1.127.0`, requires a local Git executable, and does not support virtual
workspaces.

## Verification

Use `pnpm` for project commands:

```bash
pnpm install
pnpm test
```

The aggregate test runs type checking, linting, unit tests, the JSX/browser
test, and Extension Host integration suites. Individual checks are available
as `pnpm run check-types`, `pnpm run lint`, `pnpm run test:unit`,
`pnpm run test:browser`, and `pnpm run test:integration`.

The integration contract verifies persisted metadata, gzip snapshots, cleanup,
external writes, save/open/command/folder paths, dynamic ignore changes, and
Git-index immutability. The disabled and restart suites verify opt-out and
startup behavior. Unit/browser tests cover Git identity and diff handling,
ignore matching, reviewer caching, duplicate transfer, marker placement, and
parser-valid JSX output.

For a manual smoke check, verify setup persistence, Start Reviewed and Start
Pending, saved and external-file reconciliation, editing and saving the right
side of an open diff followed by a left-side review action, dirty-editor
rejection, stale baseline rejection, automatic promotion, source deletion
cleanup, and both positive and negative metadata/snapshot results for eligible,
ignored, and disabled paths.
