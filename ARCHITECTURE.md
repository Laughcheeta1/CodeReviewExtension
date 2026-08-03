# Architecture

## Authorities and scope

Code Review Tracker 0.4.0 is a single-reviewer, saved-content system:

1. The gzip baseline snapshot is authoritative for reviewed old content.
2. The saved source file is authoritative for current content.
3. Local `git diff --no-index` output is authoritative for unchanged, added, and deleted classification.
4. Per-file JSON is authoritative for review state only for its exact baseline and current digests.

Git is not used for pulls, HEAD synchronization, commit-author inference, or imported review decisions. A replacement is deliberately stored as deleted old lines plus added new lines. There is no synthetic `modified` classification.

## Modules

- `domain.ts` defines v4 records, exact physical-line hashing, diff record construction, review transfer, status, and counts.
- `git.ts` runs the required deterministic local Git diff and parses zero-context hunk headers.
- `snapshot.ts` encodes and validates gzip snapshots.
- `storage-format.ts` validates schema 4 and derives lightweight summaries.
- `store.ts` owns per-path transactions, the eight-entry detail cache, snapshot verification, and orphan cleanup.
- `review-service.ts` owns stable reads, per-source operation serialization, recomputation, selection/hunk mutations, initialization, deletion, and promotion.
- `ui.ts` owns the baseline provider, native-diff decorations, sidebar, and explorer badges.
- `extension.ts` registers commands and lifecycle events.

## Exact content identity

SHA-256 hex digests are calculated over exact file bytes for `baseline.digest` and `current.digest`. Physical-line digests include their terminator bytes, so these are distinct:

```text
"value\n"
"value\r\n"
"value"       (no final newline)
```

Blank and whitespace-only lines are records. Input must be UTF-8 text, contain no NUL byte, and fit `codeReviewTracker.maxFileSizeBytes`.

### Line identity

Baseline-originating lines use the SHA-256 of their exact physical bytes, a NUL separator, and their immutable one-based baseline line number. This identifies both unchanged and deleted versions of the same reviewed line.

Only repeated added lines are annotated during saved-document reconciliation. Each receives a language-appropriate `RevExt: N` end-of-line comment; its digest is the complete tagged physical line. Unique additions are left untouched. Existing tagged duplicates retain their marker through the review cycle, and promotion removes markers before writing the clean next baseline.

Unsafe, unsupported, or unannotated additions retain the conservative digest-plus-occurrence transfer rule.

## Diff generation

Baseline and current bytes are written to a temporary directory and passed to:

```text
git diff --no-index --no-ext-diff --no-textconv --no-color --text
  --unified=0 --diff-algorithm=myers --indent-heuristic
```

Exit code 0 means unchanged, 1 means a valid diff, and every other result is an error. Temporary files are always removed.

Git hunk ranges identify old deletions and new additions. The model fills unchanged spans from the two source arrays. It never pairs old/new lines into changes. Hunk membership is derived directly from those zero-context ranges.

## Per-file schema

Each `<sha256(relative-path)>.json` has `schemaVersion: 4`, the normalized relative path, and:

- a baseline snapshot filename, SHA-256 digest, `gzip` codec, uncompressed byte size, and creation time;
- a current SHA-256 digest, last reconciled filesystem mtime/size, `myers` algorithm identifier, and reconciliation time;
- `lastReviewTime`, updated only by an explicit line or file review action;
- `updatedAt`, recording the last metadata write;
- `fileStatus`, a fast sidebar cache that must equal the status derived from line records;
- `nextRevExtId`, the next per-file marker number for the current baseline generation;
- every current physical line with one-based line number, digest, occurrence, `changeType: unchanged | added`, independent `reviewStatus`, and optional decision metadata;
- deleted baseline lines with one-based old line number, digest, occurrence, independent `reviewStatus`, and optional decision metadata;
- Git hunk old/new ranges.

Persisted objects are defined with explicit TypeScript interfaces. The complete saved-review model is:

```ts
type ReviewStatus = "pending" | "inReview" | "reviewed";
type ChangeType = "unchanged" | "added";

interface Reviewer {
    name: string;
    email?: string;
}

interface LastReviewer {
    name: string;
    email?: string;
    time: string; // ISO-8601
}

interface SourceSnapshot {
    modifiedAt: number;
    size: number;
}

interface BaselineDescriptor {
    file: string; // snapshots/<pathHash>.<baselineDigest>.gz
    digest: string; // SHA-256 of the exact baseline bytes
    codec: "gzip";
    size: number; // uncompressed byte size
    createdAt: string; // ISO-8601
}

interface CurrentDescriptor extends SourceSnapshot {
    digest: string; // SHA-256 of the exact saved bytes
    gitAlgorithm: "myers";
    generatedAt: string; // ISO-8601 reconciliation time
}

interface DiffHunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
}

interface StoredFile {
    schemaVersion: 4;
    path: string;
    file: FileRecord;
}

interface FileRecord {
    baseline: BaselineDescriptor;
    current: CurrentDescriptor;
    fileStatus: ReviewStatus;
    lastReviewTime?: string; // ISO-8601, explicit review action time
    currentLines: readonly CurrentLineRecord[];
    deletedLines: readonly DeletedLineRecord[];
    hunks: readonly DiffHunk[];
    nextRevExtId: number;
    updatedAt: string; // ISO-8601 metadata write time
}

interface CurrentLineRecord {
    line: number;
    digest: string;
    occurrence: number;
    changeType: ChangeType;
    reviewStatus: ReviewStatus;
    lastReviewer?: LastReviewer;
}

interface DeletedLineRecord {
    baselineLine: number;
    digest: string;
    occurrence: number;
    changeType: "deleted";
    reviewStatus: ReviewStatus;
    lastReviewer?: LastReviewer;
}
```

`Reviewer` is transient input collected when a user makes a decision; only the resulting `LastReviewer` is persisted on a changed line. `SourceSnapshot` is the shared filesystem metadata portion of `CurrentDescriptor`. `BaselineDescriptor`, `CurrentDescriptor`, `CurrentLineRecord`, `DeletedLineRecord`, `DiffHunk`, and `FileRecord` are nested in the persisted `StoredFile` JSON record.

`FileSummary` is a derived sidebar/cache model, not an additional persisted review record. `PhysicalLine` and `RawGitHunk` are transient diff-generation models and are not saved. Hunk membership is derived from each zero-context Git range instead of storing duplicate arrays of line numbers. An unchanged line does not store a baseline line or old digest because neither value participates in review transfer or UI mapping. Keeping the persisted contract interface-based makes schema changes visible to the compiler and keeps storage validation aligned with the domain model.

Unchanged records are automatically `reviewed` without inventing reviewer attribution. Pending is an explicit status; `lastReviewer` is omitted when no non-pending human decision exists.

`fileStatus` is never an independent authority. The storage boundary recomputes it before every write, and the parser rejects metadata whose cached value disagrees with the line records. The cache exists so the sidebar can load one small summary per file without retaining every detailed record.

Older schemas are ignored, not migrated. Dismissing first-launch initialization leaves them untouched. Choosing either initialization mode resets the tracker directory before writing v4.

## Initialization choices and tracking scope

Before a new workspace creates review metadata, the extension asks whether to initialize it. A workspace-local `initialization.json` records either a disabled state, which suppresses all future automatic initialization, or an initialized state with the selected file targets. The setup checklist starts with every candidate selected: workspace files filtered by root and nested `.gitignore` rules when those files exist, otherwise every workspace file. Git's global configuration and `.git/info/exclude` are deliberately not consulted. Startup, refresh, save, and file-creation reconciliation only create metadata for paths inside that saved scope. Existing metadata without this file remains compatible and is treated as tracking the workspace root.

## Snapshot transaction

Snapshots use `snapshots/<pathHash>.<baselineDigest>.gz`.

1. Exact baseline bytes are gzip-compressed to a unique temporary file.
2. The temporary gzip is read back with a decompression cap and verified against digest and uncompressed size.
3. It is renamed to its content-addressed target.
4. JSON is written to a unique sibling temporary file and atomically renamed over the per-file record.
5. The previously referenced snapshot is removed only after the JSON commit.

A failed JSON commit leaves the old JSON and snapshot authoritative; the new snapshot is an orphan cleaned on a later safe startup. Temporary snapshot and JSON files are removed in `finally` blocks, and startup removes leftovers from interrupted processes. Unreferenced gzip files are deleted only when every metadata file was parsed safely. Corrupt, mismatched, oversized, binary, or invalid-UTF-8 inputs leave existing review decisions intact.

Deleting a source removes its JSON, referenced snapshot, summary, cache entry, and sidebar entry.

## Recompute and review transfer

Startup normally stats known sources and skips content reads when mtime and size still match. Save, manual refresh, diff opening, and review mutations force a stable saved-file read and digest check.

### Why review time is not the startup checkpoint

`lastReviewTime` answers when the user last made a review decision. It does not identify which saved bytes the metadata already describes. A file may be saved and reconciled at 10:00 while remaining pending from a 09:00 review. Comparing file mtime to review time would diff that already-reconciled file again on every activation.

The current descriptor therefore records three separate reconciliation facts:

```text
modifiedAt   filesystem mtime observed by the last successful pipeline
size         filesystem byte size observed by that pipeline
digest       SHA-256 of the exact saved bytes processed by that pipeline
```

On activation, `(mtime, size)` is the inexpensive filter:

- if both match, startup skips reading, decompressing, and diffing that file;
- if either differs, the extension stable-reads the file and runs the pipeline;
- if a source is missing, its metadata and snapshot are removed.

Mtime and size are optimization signals, not content authority. Before opening a diff or mutating review state, the extension stable-reads the saved file and verifies its digest even if the stat pair appears unchanged. A digest mismatch forces recomputation and makes old diff URIs stale. This combination gives fast normal startup without allowing a review action to apply to unverified bytes.

The choice and its possible alternatives are intentionally recorded in `TODO.md` for a later design discussion.

### The reconciliation pipeline

The implementation follows the agreed previous-added/previous-deleted pipeline, with explicit duplicate safety:

1. Index existing added records by exact line digest and ordered added-side occurrence. Index deleted records by exact digest and baseline line number.
2. Load and validate the compressed baseline, stable-read the saved source, and run the required local Git diff.
3. Rebuild current unchanged ranges from the baseline/current arrays. Unchanged lines are automatically reviewed.
4. For every Git deletion, reuse the previous deleted record with the same digest and exact baseline line. A new deletion starts pending.
5. For every Git addition, reuse the previous added record with the same `(digest, occurrence)` when the number of identical added records is unchanged. A new addition starts pending.
6. A previous deletion absent from the new Git result was restored. It naturally reappears in the rebuilt unchanged range as reviewed and is absent from `deletedLines`.
7. A previous addition absent from the new Git result was removed. It is absent from the rebuilt current-line array.
8. Recompute the cached file status from all remaining addition/deletion review states and atomically persist the new generation.

Both `reviewed` and `inReview` decisions transfer when identity remains unambiguous. New or changed records start pending. Rebuilding the generation produces the same transitions as mutating sets in place while preventing stale removed records from surviving accidentally.

### Operation serialization

Saved-file reconciliation, diff preparation, baseline reads, line/file decisions, deletion, and promotion are serialized per source URI. This prevents two asynchronous VS Code events from reading the same old generation and committing conflicting successors. Workspace initialization temporarily blocks new source operations and waits for existing source operations before resetting metadata. The persistence layer also serializes writes per path; a failed write does not poison the next queued operation.

### Duplicate-addition safety

Occurrence solves duplicate identity while the number and order of identical added records remain stable. One case is fundamentally ambiguous without saving another full current snapshot:

```text
previous additions: identical occurrence 1 pending, occurrence 2 reviewed
new additions:      one identical occurrence remains
```

The baseline diff cannot prove which occurrence was removed. Blind occurrence matching could incorrectly transfer `reviewed` to the pending survivor. The implementation therefore uses a fail-safe rule: if the cardinality of an identical added digest changes, no decision transfers for that digest and its surviving additions become pending.

Deleted duplicates do not have this ambiguity because immutable baseline line numbers identify the exact old occurrences.

This conservative reset spends a small amount of repeat-review effort to guarantee the extension never accepts an ambiguous line automatically. Alternatives are tracked in `TODO.md`.

### Workspace coverage and save authority

Git remains only the diff executable. Eligible files are enumerated from the workspace rather than `git ls-files`, so new and untracked saved files cannot disappear from review tracking. After a workspace has been initialized, a newly discovered eligible file receives an empty baseline and is classified as added/pending. Tracker files, `.git`, and `node_modules` remain excluded even when saved directly.

The pipeline runs from `onDidSaveTextDocument`, startup reconciliation, and manual refresh. Ordinary buffer-change events refresh presentation only. This prevents reverted, unsaved editor text from becoming shared review metadata.

Stable reads compare stat information before and after reading and retry once. If a concurrent writer keeps changing the file, the pipeline aborts without replacing existing metadata.

## Native diff UI and stale safety

The read-only `code-review-baseline:` provider validates the digest-addressed snapshot before returning UTF-8 text. Its URI embeds the baseline and current digests. The right pane is the real saved source URI.

- Right selections map only to added records.
- Left selections map only to deleted records.
- Unchanged-only selections report that no reviewable changes were selected.
- Decorations and hover text appear in both panes.

Before every mutation the service stable-reads the source and validates both URI digests. A stale diff is rejected and must be reopened. Dirty source editors are rejected with a save-first message.

When every addition and deletion is reviewed, promotion stable-reads and verifies the expected current digest, writes the saved bytes as the next baseline, replaces the record with unchanged/reviewed current lines, clears deletions/hunks, retires the old snapshot, and closes obsolete native diff tabs.

## Performance boundaries

Startup keeps one summary per file and at most eight detailed records. An unchanged startup path performs metadata parsing plus filesystem stats. Baselines are decompressed and Git is invoked only for changed/forced files or when a baseline pane is opened. File-size and decompression limits bound memory use.

## Verification

### Automated checks

Prerequisites: Node.js, npm, Git, and VS Code.

```bash
npm ci
npm test
npm run package:vsix
unzip -l code-review-tracker-0.4.0.vsix
```

For diagnosis, the aggregate command is split into `check-types`, `lint`, `test:unit`, and `test:integration`. The unit suite covers exact physical lines, LF/CRLF and final-newline identity, Git hunk parsing and no-index execution, addition/deletion classification, marker allocation, baseline-line identity, derived file-status validation, v4 topology validation, old-schema rejection, and gzip corruption/limit checks.

### Extension Host smoke test

Run the extension in an Extension Development Host, open a local filesystem workspace with Git installed, and verify:

1. Dismiss initialization, reload, and confirm the prompt returns without tracker changes.
2. Choose **Start Reviewed** and confirm JSON plus gzip snapshots appear.
3. Edit and save a file with additions, deletions, blank lines, and a replacement.
4. Open **Code Review: Open Review Diff**. Confirm the replacement is an independent left deletion and right addition.
5. Review a right-side selection and a left-side selection. Confirm unchanged selections are ignored.
6. Leave an editor dirty and confirm diff opening/review mutations require a save.
7. Change and save the file while an old diff is open; confirm old actions are rejected as stale.
8. Review every addition/deletion and confirm automatic promotion closes the diff.
9. Delete the source and confirm its JSON, gzip, summary, and sidebar row disappear after the next startup.
10. Repeat with **Start Pending** and confirm every physical current line, including blanks, is an addition.

### Package smoke test

```bash
code --install-extension ./code-review-tracker-0.4.0.vsix --force
code --list-extensions --show-versions
```

Confirm the installed entry is `local.code-review-tracker@0.4.0`, then repeat the saved-only native-diff workflow in a clean VS Code window.
