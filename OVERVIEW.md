# OVERVIEW — Code Review Tracker (v0.5.23, exhaustive)

This is the complete, file-by-file behavioral reference for the extension as
implemented in the current working tree. It covers the ontology (every type
and record), every command, every setting, every menu/keybinding/view, every
lifecycle event, the diff/transfer/promotion engine, RevExt markers, reviewer
identity, persistence, concurrency, UI, error messages, and known limits.

Normative spec: `ARCHITECTURE.md`. User guide: `README.md`. Runtime entry:
`src/extension.ts`. Manifest: `package.json`. This file explains; it does not
override.

---

## 1. What the extension is and is not

- It is a **local, saved-content, line-level review tracker** per VS Code
  workspace folder. Each tracked file has a **reviewed baseline** (gzip
  snapshot under `.vscode/code-review-tracker/snapshots/`) and a **current
  saved file on disk**. `git diff --no-index` between the two yields the
  reviewable lines.
- Review state exists only for the exact `(baseline.digest, current.digest)`
  pair in the record. Anything else is recomputed.
- Dirty (unsaved) editor buffers are **never** authoritative and never
  reviewable. Save first; every diff/mutation path rejects dirty sources.
- It is **not** a source-control provider. It does not read `HEAD`, stage,
  commit, push, pull, fetch, compare branches, or sync collaborators.
- It **does** shell out to a local `git` executable for two things only:
  1. `git diff --no-index` as the hunk engine (`src/git.ts`),
  2. `git config --get user.name / user.email` as the first reviewer source.
- Requirements: local workspace files, local Git executable, VS Code
  `^1.127.0`. Virtual workspaces unsupported
  (`capabilities.virtualWorkspaces.supported: false`). Restricted Mode
  supported with limited functionality (terminal `agentCommand` needs trust).
- Activation: `onStartupFinished`. Kind: `workspace` extension.

---

## 2. Module map (`src/`)

| File | Owns |
|---|---|
| `extension.ts` | `activate()`: service construction, startup sequence, providers, commands, watchers, auto-open, setup prompt. `EXTENSION_VERSION = "0.5.23"` log line. |
| `review-service.ts` | Orchestration boundary: stores, eligibility sets, recompute, init, external/save handling, baseline URIs, diff prep, mark entry points, serialization. ~1230 lines. |
| `domain.ts` | Byte/line identity, `buildDiffRecords`, transfer rules, `newlyAddedLineNumbers`, `updateAddedLineDigests`, `terminalPayload`, status derivation. |
| `source-io.ts` | `readStableSource` (torn-read-proof), `diffWithProgress`, `createRecord`. |
| `git.ts` | `GitService.diff` (temp files + `git diff --no-index`), `GitService.reviewer` (`user.name`/`user.email`). |
| `store.ts` | `PersistentStore`: summaries, 8-entry detail cache, load/commit/delete/reset, init config, snapshot cleanup. |
| `store-io.ts` | `StoreFileSystem`: atomic snapshot/JSON/init writes, temp-file discipline. |
| `storage-format.ts` | `StoredFile` v4 schema, `pathHash` naming, `summarize`, `sourceMayHaveChanged`, strict `parseStoredFile` + `isConsistent`. |
| `snapshot.ts` | `encodeSnapshot` (`gzipSync`), `decodeSnapshot` (size/digest/maxSize verified `gunzipSync`). |
| `tracking.ts` | `initialization.json` schema 1, `tracksPath`. |
| `git-ignore.ts` | `GitIgnoreService`: read/cache workspace `.gitignore` files, fail-closed. |
| `ignore-matcher.ts` | `WorkspaceIgnoreMatcher`: root + nested scope evaluation over the `ignore` npm package, case-sensitive. |
| `workspace-discovery.ts` | `eligibleWorkspacePaths`: `findFiles("**/*")` minus hard excludes minus ignored. |
| `review-service-utils.ts` | `now()`, `initialAdditionHunks`, `progressIncrement`, `selectedLines`, `isExcludedPath`, `isFileNotFound`. |
| `revext.ts` | `revExtEdits` / `revExtRemovals` / `revExtMarkerStart` (duplicate-group annotation planning). |
| `revext-syntax.ts` | Language→comment-token map, marker regexes, legacy JSX recognition. |
| `revext-config.ts` | `isRevExtDisabled` (extension-suffix opt-out). |
| `revext-annotation.ts` | `recomputeSavedDocument`, `recomputeExternalSource`, `annotatePendingDocument` (edit + internal-save + rescan). |
| `review-mutations.ts` | `initializePendingFile`, `requireFresh`, `commitReview`, `applyReview`, `promote`. |
| `review-actions.ts` | `markEditor`, `markFile`, `markFolder` (selection→record matching). |
| `review-commands.ts` | VS Code-facing wrappers: `openReviewDiff`, `openDocumentInReviewView`, `closePromotedDiffTabs`, reviewer prompting, `markActive/markFile/markFolder`, `initializeAll`, `sendSelection`. |
| `initialization-setup.ts` | `promptForInitialization` + preselected multi-file QuickPick (`chooseTrackingTargets`). |
| `reviewer.ts` | `ReviewerCache` (globalState `reviewerCache`) + `ReviewerResolver` (dedup concurrent resolves). |
| `review-progress.ts` | `folderProgressMessage`. |
| `ui.ts` | `BaselineContentProvider`, `ReviewDecorations`, `ReviewFileDecorations`, `ReviewTree`. |
| `extension-utils.ts` | `errorMessage`, `runLogged` (no unhandled rejections). |

---

## 3. Ontology — every type and what it means

### 3.1 `ReviewStatus` and `ChangeType` (`domain.ts:3-4`)

```ts
type ReviewStatus = "pending" | "inReview" | "reviewed";
type ChangeType = "unchanged" | "added";   // deletions live in their own list
```

- There is **no `"modified"` and no `"deleted"` in `ChangeType`**. A replaced
  line is one `deleted` record (old side) plus one `added` record (new side).
- `pending`: needs a decision. `inReview`: looked at, not done. `reviewed`:
  accepted. Only `added` + `deleted` lines can carry these; `unchanged` is
  always `reviewed` with no reviewer.
- `fileStatus(file)` derivation (`domain.ts:132-145`):
  - `reviewed` if zero reviewable lines, or every reviewable line `reviewed`;
  - else `inReview` if any reviewable line is not `pending` (i.e. mixed);
  - else `pending`.
- `reviewCounts(file)` = `{ reviewed: #reviewed reviewable, total:
  #reviewable }`. `reviewableLines(file)` = added current lines +
  all deleted lines.

### 3.2 People: `Reviewer` / `LastReviewer` (`domain.ts:6-15`)

```ts
interface Reviewer { name: string; email?: string }
interface LastReviewer { name: string; email?: string; time: string } // ISO
```

- `setReviewer(status, reviewer, at)`: `pending` → `undefined` (clears
  attribution); non-pending requires a `Reviewer` or throws; stamps `time`.
- `applyReview` writes `lastReviewTime: at` and `updatedAt: at` on the file
  whenever any line changes.
- Resolution order per workspace (`reviewer.ts`, `review-commands.ts`,
  `git.ts`):
  1. in-memory + `globalState.reviewerCache[workspaceKey]` (key = workspace
     folder URI string, or `"global"` when no folder),
  2. local Git `user.name` (+ optional `user.email`; name empty → skip),
  3. configured `reviewerName`/`reviewerEmail`,
  4. interactive `showInputBox` for name (required) then email (optional).
- The interactive fallback **persists**: entered name is written to global
  `reviewerName`, entered email to global `reviewerEmail` (only when those
  were previously empty), and the resolved identity is cached. `pending`
  decisions never consult or store identity.
- Concurrent resolves for the same workspace share one promise
  (`ReviewerResolver.resolutions`), cleared after settling.

### 3.3 Content identity (`domain.ts:89-120`)

- File digest: `digestBytes = SHA-256 hex(exact bytes)`. Applies to
  `baseline.digest` and `current.digest`.
- `physicalLines(bytes)`: validates fatal-UTF-8 (throws on invalid), then
  splits **only at `0x0A`**, keeping each terminator. Consequences:
  - `"\n"` vs `"\r\n"` vs no-final-newline are different bytes → different
    digests;
  - blank line = `"\n"` (length 1); CRLF blank = `"\r\n"` (length 2);
  - whitespace-only line (e.g. `"   \n"`) is *not* blank;
  - empty file = zero physical lines.
- `isEmptyPhysicalLine(bytes)`: last byte is `0x0A` AND length is 1, or
  length 2 with `0x0D` first. Used only by `ignoreEmptyLineDeletions`.
- Unchanged/deleted line digest (`baselineLineDigest(line, n)`):
  `SHA-256(line bytes + 0x00 + ASCII(n))`. The NUL separator is unambiguous
  because NUL bytes are rejected in tracked sources. The embedded 1-based
  baseline number distinguishes equal strings at different positions and lets
  a restored line hash-match its old self → rebuilt as `unchanged`.
- Added line identity: `(digest = SHA-256(current physical bytes),
  occurrence)`. `occurrence` is the 1-based rank of that digest among added
  lines in diff order (`nextOccurrence`). RevExt suffix bytes are part of the
  digest while present.

### 3.4 `FileRecord` — the per-file truth (`domain.ts:61-71`)

```ts
interface CurrentLineRecord {
  line: number;            // 1-based, dense over current file
  digest: string;          // sha256 hex
  changeType: "unchanged" | "added";
  reviewStatus: ReviewStatus;
  occurrence: number;      // >= 1
  lastReviewer?: LastReviewer;
}
interface DeletedLineRecord {
  baselineLine: number;    // 1-based baseline number (identity component)
  digest: string;          // baselineLineDigest
  occurrence: number;
  changeType: "deleted";
  reviewStatus: ReviewStatus;
  lastReviewer?: LastReviewer;
}
interface DiffHunk { oldStart: number; oldCount: number; newStart: number; newCount: number }
interface FileRecord {
  baseline: { file: string; digest: string; codec: "gzip"; size: number; createdAt: string };
  current:  { digest: string; modifiedAt: number; size: number; gitAlgorithm: "myers"; generatedAt: string };
  fileStatus: ReviewStatus;
  lastReviewTime?: string;
  currentLines: CurrentLineRecord[];   // one per current physical line
  deletedLines: DeletedLineRecord[];
  hunks: DiffHunk[];                   // zero-context, effective ranges
  nextRevExtId: number;                // monotonic marker counter (>= 1)
  updatedAt: string;
}
```

- `currentLines` covers **every** current line (unchanged + added), so
  `line === index+1` is an invariant enforced on read.
- `deletedLines` has no ordering invariant beyond unique `baselineLine`s;
  hunk ranges must exactly cover the added-line set and deleted-line set
  with no overlaps (`isConsistent`).
- `PhysicalLine = { digest, bytes }`, `RawGitHunk` = same shape as
  `DiffHunk`, `DiffOptions = { ignoreEmptyLineDeletions? }`.
- `SourceSnapshot = { modifiedAt, size }` — the stat pair. Optimization
  signal only, never content authority.
- `BaselineDescriptor.size` = uncompressed byte length. `codec` is always
  `"gzip"`, `gitAlgorithm` always `"myers"`.

### 3.5 `StoredFile`, `FileSummary`, naming (`storage-format.ts`)

```ts
interface StoredFile { schemaVersion: 4; path: string; file: FileRecord }
interface FileSummary { status; reviewed; total; source: SourceSnapshot; baselineFile: string }
```

- `pathHash(path) = SHA-256 hex(relative path)`; `storageFileName =
  "<hash>.json"`; `snapshotFileName = "<hash>.<baseline-digest>.gz"`.
- `storedFile()` strips everything but the persisted fields before write.
- `summarize(file)` derives status/counts/stat/snapshot name for the sidebar
  without loading details.
- `sourceMayHaveChanged(mtime, size, source)` = true when no record or stat
  differs. Used for the fast path only.
- `parseStoredFile` rejects: wrong schema, absolute/empty/backslash/NUL/`.`
  /`..` paths, bad digests/timestamps/counters, `fileStatus` ≠ derived,
  non-dense lines, reviewer/status mismatch (unchanged must be
  reviewed-without-reviewer; pending must have no reviewer; decided must have
  one), hunk/line-set mismatch. Anything older or malformed is **ignored,
  never migrated**.

### 3.6 Tracking configuration (`tracking.ts`)

```ts
interface TrackingTarget { kind: "file" | "folder"; path: string } // "" = root
interface InitializationConfiguration {
  schemaVersion: 1;
  state: "disabled" | "initialized";
  targets?: TrackingTarget[];
}
```

- `disabled` = opt-out ("Never Initialize"), blocks all automatic paths.
- `initialized` requires a non-empty `targets` array.
- `tracksPath(path, config)`: true iff initialized and some target matches —
  file target by equality; folder target by equality, prefix `target/`, or
  root `""`.
- Targets are a **seed that grows**: `includeTrackingTarget(s)` appends
  uncovered candidates and rewrites `initialization.json`. Reset only via
  setup / whole-workspace init (`store.reset()` preserves the chosen config,
  wipes everything else).

---

## 4. Persisted layout and write protocol

```text
<workspace>/.vscode/code-review-tracker/
  initialization.json
  <sha256(relative-path)>.json          # StoredFile v4
  snapshots/
    <sha256(relative-path)>.<baseline-digest>.gz
```

Plus legacy-owned paths `.vscode/code-review-tracker.json` and
`.vscode/code-review-tracker.v1.migrated.json` (recognized by `owns()`,
removed on `reset()`).

Example metadata (shape; hashes/times illustrative):

```json
{
  "schemaVersion": 4,
  "path": "src/app.ts",
  "file": {
    "baseline": { "file": "<hash>.<digest>.gz", "digest": "<sha256>", "codec": "gzip", "size": 412, "createdAt": "2026-…Z" },
    "current": { "digest": "<sha256>", "modifiedAt": 1724…, "size": 430, "gitAlgorithm": "myers", "generatedAt": "2026-…Z" },
    "fileStatus": "pending",
    "currentLines": [{ "line": 9, "digest": "<sha256>", "changeType": "added", "reviewStatus": "pending", "occurrence": 1 }],
    "deletedLines": [{ "baselineLine": 4, "digest": "<sha256>", "occurrence": 1, "changeType": "deleted", "reviewStatus": "pending" }],
    "hunks": [{ "oldStart": 4, "oldCount": 1, "newStart": 9, "newCount": 1 }],
    "nextRevExtId": 3,
    "updatedAt": "2026-…Z"
  }
}
```

Write protocol (`store-io.ts`, `store.ts:200-248`):
1. Snapshot (only when baseline bytes supplied): assert bytes match
   descriptor; if target exists and verifies, reuse; else write
   `<name>.tmp-<uuid>`, read back, `decodeSnapshot`-verify, rename with
   `overwrite: false`, delete temp in `finally`.
2. JSON: `createDirectory`, write `.<name>.tmp-<uuid>`, rename with
   `overwrite: true`, delete temp in `finally`.
3. On commit with a changed snapshot name, delete the previous snapshot only
   after the JSON rename. On JSON failure the old record stays authoritative
   and the new snapshot may orphan until safe startup cleanup.
4. `cleanupSnapshots` (at init, only if every metadata file parsed cleanly):
   delete `*.tmp-*` and unreferenced `*.gz`. `loadSummaries` deletes
   directory-level `*.tmp-*` on sight.
5. `delete(path)`: read old record (warn + continue if unreadable), delete
   JSON (ignore FileNotFound, rethrow others), delete its snapshot, drop
   summary + cache entry.

In-memory (`store.ts`): `summaries` (one per known path), `cache` (≤8 detail
records, insert-order eviction), `loadTails` (coalesce concurrent loads),
`writeTails` (per-path serialize). `peek` touches LRU; `load` coalesces;
`commit` recomputes `fileStatus` before enqueue.

---

## 5. Eligibility — the five gates

In order, for any write (`review-service.ts:1133-1175`,
`review-service-utils.ts:35-46`):

1. **URI shape**: `scheme == file`, inside an open workspace folder, and
   `!store.owns(uri)` (never track the tracker's own directory/files).
2. **Hard excludes** (`isExcludedPath`): `.git[/…]`, `node_modules[/…]`,
   `.vscode-test[/…]`, `.vscode/code-review-tracker[/…]`.
3. **Init state**: `initializationState == "initialized"` and
   `tracksPath(path)`.
4. **Ignore rules**: not matched by workspace `.gitignore` evaluation (root +
   nested, `ignore` package, case-sensitive). Any evaluation error →
   **fail closed** (no write; on cleanup, preserve existing metadata).
   Global excludes, `.git/info/exclude`, and git config are never consulted.
5. **Content guards** (`readStableSource`): size ≤ `maxFileSizeBytes`,
   fatal-UTF-8 decodable, no NUL bytes.

Two cached sets per folder: `discoveredPaths` (enumeration minus ignores)
and `eligiblePaths` (discovered ∩ `tracksPath`). Enumeration
(`eligibleWorkspacePaths`): `findFiles("**/*")` with a
`**/{.git,node_modules,.vscode-test,.vscode/code-review-tracker}/**`
exclude, `asRelativePath` with backslash→slash normalization, `refresh()`
ignore rules, filter ignored.

---

## 6. Startup and every lifecycle event (`extension.ts`, `review-service.ts`)

### 6.1 Activation sequence

1. Output channel `Code Review Tracker` (`{ log: true }`); no folders → log
   and return.
2. Construct `GitService`, `ReviewerResolver(git, ReviewerCache(globalState))`,
   `GitIgnoreService`, `ReviewService`; `await service.initialize()` (per
   folder: `loadInitialization` + `loadSummaries`; root-tracked compat if
   metadata exists without init file; `cleanupSnapshots` when safe).
3. Per folder: `cleanupMissingSources` → `refreshFolder` (enumerate, set
   eligible, `cleanupIgnoredSources`, `reconcileExternalChanges`) →
   `initializeDiscoveredSources` (include all eligible as file targets,
   create records for paths without summaries).
4. Register: `code-review-baseline` content provider, tree + file-decoration
   providers, `onDidOpenTextDocument`, `onDidCloseTextDocument` (forget
   internal-load tag), `onDidSaveTextDocument`, `onDidChangeConfiguration`
   (only `ignoreEmptyLineDeletions`), `onDidPromote → closePromotedDiffTabs`,
   `onDidChangeVisibleTextEditors` (+ `setTimeout 0` recheck for manual
   opens), all commands, per-folder `**/*` watcher (create/delete/change) and
   `**/.gitignore` watcher (create/change/delete → refresh without
   reconcile, then `initializeDiscoveredSources`).
5. Auto-open review view for already-visible editors; `promptForInitialization`
   (skips configured folders); `decorations.refresh()`; log
   `Code Review Tracker 0.5.23 activated.`

### 6.2 Open / visible

- `onDidOpenTextDocument`: internal loads return immediately; else
  `openDocumentInReviewView` (coalesced per URI via `openingDocuments`).
- `openDocumentInReviewView`: `initializeOpenedDocument` (no-op unless
  initialized, clean, eligible — refreshes eligibility, then
  `initializeMissingSource` which re-refreshes with force on miss, includes
  the file target, and `recompute(createMissing: true)` under the per-URI
  lock) → `ensureDocument` (loads record into cache for decorations; skips
  untrackable/ineligible/already-loaded; coalesced per URI) → if
  `openFilesInReviewView` (default true) and initialized, `openReviewDiff`.
- `onDidChangeVisibleTextEditors` delayed pass: for visible file editors that
  are not diff-modified panes and have no plain-text tab, consume one
  internal-load tag and auto-open. This preserves "internal loads stay
  invisible; the later manual open still auto-opens" (`ARCHITECTURE.md`).

### 6.3 Save (`reconcileSavedDocument` → `recomputeSavedDocument`)

Eligibility → include-then-recompute if untracked → `withSource` →
RevExt-aware save pipeline (§8): diff baseline vs saved bytes, compute added
set, `newlyAddedLineNumbers`, `revExtEdits` over live document lines, apply
`WorkspaceEdit` inserts + internal `save()` when needed, rescan, rebuild with
`updateAddedLineDigests` bridging, commit. Internal saves tagged so the
resulting save event returns early. Any error → warn log with path.

### 6.4 External change (`reconcileExternalSource`)

Same as save but from host bytes: `readStableSource` → diff → if document
dirty, recompute without annotating (never rewrite a dirty buffer); else
annotate via byte-level `applyByteEdits` + direct `fs.writeFile` under an
internal-save tag, rescan, bridge, commit. `FileNotFound` → session-hide.

### 6.5 Create / delete / ignore / refresh / policy

- Create (`reconcileCreatedSource`): ignore init/disabled/owned/excluded;
  force-refresh eligibility; `initializeMissingSource`; add to eligible set;
  fire change.
- Delete (`hideSources`): remove from in-memory eligible set only, fire
  change. Disk records + snapshots are deleted at next startup by
  `cleanupMissingSources` (stat each `store.paths`; non-file/missing →
  `store.delete`).
- `.gitignore` event: `refreshFolder(folder, force=false, reconcile=false)` +
  `initializeDiscoveredSources`. Newly ignored → `cleanupIgnoredSources`
  deletes metadata; newly eligible → initialized.
- Refresh command: per folder `refreshFolder(folder, force=true)` — forced
  digest reconciliation over the eligible set with 4 workers and a
  `withProgress` notification (`changed/hidden` summary logged).
- `ignoreEmptyLineDeletions` change: `refreshReviewPolicy` — forced rebuild
  (`rebuildPolicy: true`) of every tracked eligible path; fires change if
  anything moved.

### 6.6 Concurrency

- `withSource(uri, op)`: per-URI promise chain; throws
  `Workspace review initialization is in progress.` when its folder is
  resetting. `initializeFolder` first `await Promise.allSettled(sourceTails)`.
- `PersistentStore.enqueue`: per-path write chain (`catch → then` so one
  failure doesn't wedge the tail).
- `ensureTails`, `loadTails`, `eligibilityRefreshes`, `refreshes`
  (ignore service) coalesce duplicate concurrent work.

---

## 7. Diff engine, transfer, promotion

### 7.1 Stable read + Git (`source-io.ts`, `git.ts`)

- `readStableSource(uri, maxSize, initialStat?)`: two attempts of
  stat → size-check → read → stat; retry when mtime/size drift or
  `bytes.byteLength != after.size`; then fatal-decode + NUL reject. Throws
  `File exceeds the configured size limit`, `Binary files are unsupported`,
  or `Source changed while it was being read: <uri>`.
- `GitService.diff(baseline, current)`: byte-compare first (equal → `[]`);
  else `mkdtemp` + write `baseline`/`current` + run
  `git diff --no-index --no-ext-diff --no-textconv --no-color --text
  --unified=0 --diff-algorithm=myers --indent-heuristic -- before after`
  (32 MB `maxBuffer`); exit 0 with different bytes → throw; exit 1 →
  parse `@@ -a[,b] +c[,d] @@` headers (missing count = 1); zero valid hunks
  with changes → throw; other failures → `Git diff failed: …`. Temp dir
  removed in `finally`. `diffWithProgress` wraps it in a Window progress
  `Code Review: comparing <path>`.
- `initialAdditionHunks(bytes)`: empty file → `[]`; else one hunk
  `{ oldStart: 0, oldCount: 0, newStart: 1, newCount: all }`.
- `createRecord(git, path, baseline, current, source, lastReviewTime?,
  rawHunks?)`: digests, `buildDiffRecords` (or Git when hunks omitted and
  digests differ), `fileStatus(diff)`, `nextRevExtId: 1`.

### 7.2 `buildDiffRecords` (`domain.ts:160-277`)

Walks raw hunks in order, emitting unchanged spans between them:

- Unchanged lines: digest = `baselineLineDigest`, status reviewed, occurrence
  from whole-file digest ranks.
- Added runs: digest = current bytes digest; occurrence within the added
  stream; `transferAddition` carries status+reviewer only when the previous
  count for that digest equals the next count; else `pending`.
- Deleted runs: digest = `baselineLineDigest(old, n)`; matched by
  `"digest:baselineLine"`; skipped (not emitted) when
  `ignoreEmptyLineDeletions` and `isEmptyPhysicalLine`; occurrence within the
  deletion stream.
- Output hunks = raw hunks, or `effectiveHunks` (old runs split around
  ignored empty deletions; pure-empty hunks with additions become
  `{ oldCount: 0 }`; pure-empty deletions vanish).

### 7.3 Recompute commit (`review-service.ts:853-977`)

Final `isEligibleSource` guard → load previous (or create when
`createMissing`) → stat fast-path (skip when allowed and mtime+size match) →
stable read → digest equal (and no policy rebuild) → touch stat or return →
else load baseline, diff (or reuse prepared hunks), `buildDiffRecords` with
current `ignoreEmptyLineDeletions`, final eligibility check, commit
`{ ...existing, ...diff, current: { digest, ...stat, myers, now }, now }`.
Empty-effective-diff under the policy → `promote` instead of commit.

### 7.4 Review mutations (`review-mutations.ts`, `review-actions.ts`)

- `requireFresh(source, identity?, forceDigest=true)`: recompute, load,
  throw `This file has not been initialized for review.` when absent; throw
  `This review diff is stale. Reopen Code Review: Open Review Diff.` only
  when the baseline digest moved. A moved *current* digest is legitimate
  (live modified side) — line matchers run against the latest record.
- `markEditor(editor, status, reviewer)`: resolve source from baseline URI;
  ignored → throw; `initializeMissingSource`; `withSource`: dirty → throw
  `Save the file before changing review state.`; `requireFresh(identity)`;
  current lines match only on the **right** (non-baseline) side by selected
  1-based lines and `changeType != "unchanged"`; deleted lines match only on
  the **left** (baseline) side by `baselineLine`. Mismatch (e.g. restored
  deletion) → no match → returns false.
- `markFile(source, status, reviewer)`: same guards; `pending` on a clean
  file → `initializePendingFile` (empty baseline over current bytes, with
  RevExt pre-annotation); else all added + all deleted.
- `markFolder(uri, status, reviewer)`: folder → prefix filter over refreshed
  eligibility (cached then forced), `includeTrackingTarget(folder)`,
  `tracksPath` filter, sorted, sequential `markFile` per path inside a
  Notification progress (`Code Review: marking folder <status>`,
  `N/total files successfully set to <status>`); per-file errors don't abort
  the loop (finally reports progress). Returns count of files where the
  mutation changed something.
- `applyReview`: maps matched lines to `(status, setReviewer(...))`, stamps
  file times, `commitReview` → eligibility recheck → `store.commit` → if
  baseline≠current and every reviewable line reviewed → `promote`, else fire
  change. Returns false when nothing matched.
- `promote(source, expected)`: eligibility → stable read → digest ≠ expected
  → recompute-and-return (no promotion) → compute `revExtRemovals` over added
  lines → `WorkspaceEdit` delete + internal save when needed → rescan →
  `createRecord(bytes, bytes, …)` preserving `lastReviewTime` → eligibility →
  commit with new snapshot → fire change + promoted (→ close diff tabs).
- `initializePendingFile`: initialized + tracked + trackable + eligible →
  stable read → `annotatePendingDocument` → rescan → eligible → commit
  empty-baseline record with `initialAdditionHunks` + new `nextRevExtId`.
- Selection mapping (`selectedLines`): VS Code 0-based selections → 1-based
  set; end line excluded when `end.character == 0` and non-empty; empty
  selection = active line.

---

## 8. RevExt duplicate markers (complete)

Why: equal added lines share a digest, so occurrence shifts would void peer
decisions. Markers make each duplicate's bytes unique.

- `revExtEdits(lines, addedLines, languageId, nextId, linesToAnnotate =
  addedLines)`: unsupported language → none; group added lines by
  marker-stripped text; advance `nextId` past existing marker ids; for groups
  ≥2, insert `markerSuffix` on lines in `linesToAnnotate` lacking a marker,
  with a known style, passing `safeForSuffix` (reject trailing `\`; reject
  `'''`/`"""` lines in Python).
- `revExtRemovals` / `revExtMarkerStart`: locate generated markers on added
  lines for promotion stripping and transparent hiding.
- Marker format: `markerSuffix = (line empty ? "" : "  ") + token +
  " RevExt: <id>"`. Regex per token:
  `(?:\s{2}<token>\s+RevExt: ([1-9]\d*)$|^\s*<token>\s+RevExt: ([1-9]\d*)$)`.
  Legacy JSX (JS/TS-React only, read-only):
  `(?:\s{2}\{/\*\s+RevExt: ([1-9]\d*)\s+\*\/\}$|^\s*\{/\*\s+RevExt:
  ([1-9]\d*)\s+\*\/\}$)`.
- Languages (`revext-syntax.ts:9-48`): `//`: javascript, javascriptreact,
  typescript, typescriptreact, java, c, cpp, csharp, go, rust, swift, kotlin,
  scala, dart, php, fsharp, groovy, objective-c, objective-cpp, solidity;
  `#`: python, ruby, shellscript, powershell, r, julia, perl, elixir; `--`:
  sql, lua, haskell; `%`: erlang; `;`: clojure, lisp, scheme, asm, assembly;
  `'`: vb. Everything else (notably HTML/CSS/JSON/YAML/Markdown) is untouched.
- `newlyAddedLineNumbers(currentBytes, addedLines, previous)`: per-digest
  previous/current counts; count changed and ≥2 → whole current group;
  else only `(digest, occurrence)` pairs absent before. Transfer stays
  conservative on count change, but annotation still covers the group so new
  duplicates diverge immediately.
- `updateAddedLineDigests(previous, before, after, addedLines,
  updatedLines)`: re-keys previous added records from before-digest to
  after-digest at the same line/occurrence so decisions bridge the internal
  rewrite; no updates → returns previous unchanged.
- Save path (`recomputeSavedDocument`): skip when disabled; missing record →
  plain recompute; already-reconciled digest → annotate whole added set (heals
  watcher-committed bytes); else only newly added; zero edits → plain
  recompute with prepared hunks; else `WorkspaceEdit.insert` at line ends +
  internal save + rescan + fresh diff + bridged recompute.
- External path (`recomputeExternalSource`): same decision tree but works on
  host bytes; dirty document → plain recompute with prepared hunks (never
  touches the buffer); else byte-level `applyByteEdits` (offset math respects
  LF/CRLF) + `fs.writeFile` under internal-save tag + rescan.
- Pending-init path (`annotatePendingDocument`): disabled → `1`; dirty →
  throw `Save the file before starting pending review.`; annotates all
  duplicate groups from id 1; zero edits → return next id without saving.
- Promotion strips markers from added lines before the clean baseline is
  written; decorations hide markers (`transparent` color) while present.
  JSX/TSX uses direct `//` suffixes, which can appear as rendered text until
  promotion — documented in README/ARCHITECTURE.
- Opt-out (`revext-config.ts`): `isRevExtDisabled(uriOrPath,
  disabledExtensions)` matches the **final** extension case-insensitively,
  dot optional (`"tsx"` ≡ `".tsx"` ≡ `".TSX"`); dotfiles/no-extension/trailing
  dot → never disabled; `undefined` list → never disabled. Applies to save,
  external, and pending-init generation; tracking/metadata still work and
  promotion still cleans old markers.

---

## 9. Commands, menus, keybindings, views (all 17 + 1 view)

Manifest commands (`package.json:33-99`):

| Command | Title | Effect |
|---|---|---|
| `markPending` | Mark Lines Pending | `markActive(pending)`; no reviewer needed; clears attribution. |
| `markInReview` | Mark Lines In Review | `markActive(inReview)`; resolves reviewer first; aborts silently if none. |
| `markReviewed` | Mark Lines Reviewed | Same as above with `reviewed`; full review triggers promotion. |
| `markFilePending/InReview/Reviewed` | Mark File … | Explorer file action; `pending` on clean file = empty-baseline init. |
| `markFolderPending/InReview/Reviewed` | Mark Folder … | Explorer folder action with progress; returns changed-file count. |
| `openReviewDiff` | Go to Review View (`$(preview)`) | Baseline-vs-saved native diff, or plain file when no hunks; info message when uninitialized; warnings on stale/dirty. |
| `setup` | Set Up Tracking | Reconfigure flow (resets tracking). |
| `initializeReviewed` | Mark Entire Workspace Reviewed | Root-folder target, current bytes = baseline, per-folder loop. |
| `initializePending` | Mark Entire Workspace Pending | Root-folder target, empty baseline, duplicates pre-annotated. |
| `sendSelectionToTerminal` | Send Selection to Agent | Fenced payload to Code Review Agent terminal. |
| `refresh` | Refresh | Forced reconcile of every folder. |
| `showLogs` | Show Logs | Reveals the output channel. |

Wrappers (`review-commands.ts`): `markActive`/`markFile`/`markFolder` all
`initializeSource` first, resolve reviewers only for non-pending, show
`The selection/file contains no reviewable changes.` /
`The folder contains no reviewable tracked files.` when nothing changed, and
surface thrown errors as warnings. `openReviewDiff` resolves through baseline
URIs, calls `prepareDiff`, shows the source directly when `hunks` is empty.
`initializeAll` enumerates per folder (error → `Tracking was not
initialized.`) then `initializeFolder(folder, status, [{folder,""}], paths)`.
`sendSelection` builds `terminalPayload` (§11) and sends with `addNewLine:
false` to the active terminal, else creates `Code Review Agent` (cwd = folder
when known), shows it, and — only on creation, only when trusted — runs
`agentCommand`.

Menus/keybindings/views: editor context (`openReviewDiff` gated by
`resourceScheme == file`, then pending/inReview/reviewed/send in
`codeReview@1-4`); editor title navigation `openReviewDiff`; explorer file
vs folder triples (`explorerResourceIsFolder`); `ctrl+alt+j/k/l` mark lines
when `editorTextFocus`; `ctrl+alt+p` sends selection; activity-bar container
`Code Review` (`resources/review.svg`) with view `Review Files`
(`codeReviewTracker.files`).

---

## 10. Settings (all 7)

| Setting | Type / default / scope | Behavior |
|---|---|---|
| `agentCommand` | string `""`, machine-overridable, `restricted: true` | Sent once when a new agent terminal is created and workspace is trusted. |
| `reviewerName` | string `""`, window | Fallback name; interactive answer is persisted globally when empty. |
| `reviewerEmail` | string `""`, window | Fallback email; same persistence rule. |
| `maxFileSizeBytes` | number `1048576`, min 1024, window | Read + snapshot-decode ceiling; exceeded → error, record preserved. |
| `ignoreEmptyLineDeletions` | boolean `false`, window | Drop LF/CRLF-only deletions; empty effective diff auto-promotes; change triggers `refreshReviewPolicy`. |
| `openFilesInReviewView` | boolean `true`, window | Visible file opens route through the native review diff. |
| `revExtDisabledExtensions` | string[] `[]`, window | Final-extension opt-out of marker generation (§8). |

---

## 11. Terminal payload (`terminalPayload`, `sendSelection`)

`selectionRanges`: dedup `(start:end)`; empty selection → active line only;
else `start = selection.start.line`, `end = selection.end.line +
(selection.end.character > 0 ? 1 : 0)` (0-based, end-exclusive-ish).
`terminalPayload(path, text, ranges)`: split on `/\r?\n/`; label 1-based
(`N` or `N - M` with `last = end>start ? end-1 : end`); fence =
backtick run of `max(3, longest run in content + 1)`; block =
`> Line <label>, file <path>:\n<fence>\n<content>\n<fence>\n`; blocks joined
with `\n` plus trailing newline. Content keeps line structure but normalizes
CRLF to LF inside the payload.

---

## 12. Native diff, decorations, sidebar

- Baseline URI: `code-review-baseline:<source.path>?source=<uri>&baseline=
  <digest>&current=<digest>`. `BaselineContentProvider` → `baselineContent`
  → `requireFresh(source, identity, forceDigest=false)` → `loadBaseline` →
  fatal-UTF-8 string. Read-only by provider nature.
- `prepareDiff(source)`: refresh eligibility (cached then forced), miss →
  `undefined`; `initializeMissingSource`; `withSource`: dirty → throw
  `Save the file before opening its review diff.`; `recompute(force=false)`;
  load + return `{ baseline, file }`.
- Right side is the live file URI: later saves keep the same baseline while
  decorations/actions resolve against the latest record (baseline digest
  still authoritative; vanished left lines are no-ops; unchanged-only
  selections do nothing).
- Gutter: grey `#8c959f` pending, amber `#d29922` in review, green `#3fb950`
  reviewed (SVG data URIs); hover `"<added|deleted|unchanged>:
  <Pending review|In review|Reviewed>[ by <name> on <time>]"`; RevExt ranges
  painted transparent. Right pane decorates added lines; left pane decorates
  deleted lines only when URI baseline digest equals the record's.
- Explorer badges: `P` / `●` / `✓`, tooltip same status text,
  green `testing.iconPassed` when reviewed, yellow `testing.iconQueued` when
  in review, `propagate: true`.
- Sidebar tree: groups Pending review / In review / Reviewed (expanded;
  `circle-outline` / `circle-filled` / `pass-filled`), files sorted by path,
  rows `label=path, description=reviewed/total`, click → `openReviewDiff`.
  Refresh is microtask-coalesced (`ReviewDecorations.scheduleRefresh`).

---

## 13. Setup flows (exact prompts)

- First activation per unconfigured folder (modal):
  `Initialize Code Review Tracker for <name>?` → `Initialize` continues,
  `Never Initialize` persists `disabled`, dismiss leaves untouched (prompt
  returns next activation; Command Palette `Set Up Tracking` resumes).
- Reconfigure: `Set up Code Review Tracker for <name>? Existing tracking
  will be replaced.` → `Set Up Tracking`.
- File picker: `Choose files to track in <name>`, all eligible files
  preselected and sorted, live `N/M files selected` placeholder, Select
  All (`check-all`) / Deselect All (`clear-all`) buttons, empty accept →
  `Select at least one file to continue.`, zero eligible →
  `There are no eligible files to track in this workspace.`, hide/dismiss →
  abort without touching disk.
- State picker: `Start Reviewed` (current saved content is the baseline) vs
  `Start Pending` (empty baseline; every line pending). Dismiss aborts.
- `initializeFolder` then: guard double-init, drain source tails,
  `store.reset()`, filter the passed candidate paths by the chosen targets,
  sort, per-path eligibility rechecks, stable reads, optional pending
  annotation, `createRecord`, commit, `enableTracking(targets)`,
  `setEligiblePaths`, fire change. Whole-workspace commands use a root folder
  target, hence "including eligible files added later".
- `disableInitialization` persists `disabled` and clears the eligible set.

---

## 14. Error / info message catalog

User-visible (warning/info) plus log warnings: `Initialize this workspace
before opening review diffs.`; `The selection/file contains no reviewable
changes.`; `The folder contains no reviewable tracked files.`; `This review
diff is stale. Reopen Code Review: Open Review Diff.`; `Save the file before
opening its review diff.` / `…changing review state.`; `This file has not
been initialized for review.`; `Ignored files cannot be tracked for review.`;
`File exceeds the configured size limit`; `Binary files are unsupported`;
`Source changed while it was being read: …`; `Workspace files have not been
enumerated.`; `Choose files or folders before initializing review tracking.`;
`This workspace is already being initialized.`; `Workspace review
initialization is in progress.`; `Could not add/save/remove RevExt identity
comments.`; `Save the file before starting pending review.`; `Git diff
failed: …` / `Git reported no diff for different file content` /
`Git returned a changed result without valid diff hunks`; `Baseline snapshot
digest or size mismatch` / `Corrupt or oversized baseline snapshot`;
`Invalid v4 per-file review metadata`; `Select at least one file…`;
`There are no eligible files…`; `Ignore rules could not be evaluated…`.
Background operations never reject unhandled (`runLogged`).

---

## 15. Verification and repo facts

- Scripts (`pnpm` only): `check-types` (`tsc --noEmit`), `compile`,
  `build` (`esbuild --production`), `lint` (eslint + integration
  `node --check`), `test:unit` (`tsx --test test/*.test.ts`),
  `test:browser` (incl. `complex-jsx-render`), `test:integration`
  (build + Electron `run.mjs`: contract/disabled/restart/inventory suites),
  `test` = all of the above, `package:vsix` (`vsce package
  --no-dependencies …`).
- Dependencies: runtime `ignore@^7`; dev `esbuild`, `eslint`,
  `typescript`, `tsx`, `@vscode/test-electron`, `@vscode/vsce`,
  `@types/node`, `@types/vscode`. Bundled to `dist/extension.js`
  (`main: ./dist/extension.js`).
- Packaging notes: `.vscodeignore` controls VSIX contents; only
  `code-review-tracker-0.5.23.vsix` is present in-tree; `dist/` is built
  output.

---

## 16. Limits and deliberate non-goals

- Same-size/same-mtime rewrites can be missed by open/display fast paths;
  the next mutation forces a digest check and heals.
- Targets can retain ignored paths after a `.gitignore` race (metadata write
  still blocked; target not rolled back).
- Deleted files session-hide; disk cleanup happens at next startup.
- Folder actions implicitly widen tracking targets to that folder.
- No virtual-workspace, no remote-filesystem, no global-exclude support; Git
  index never touched; binary/oversized/invalid-UTF-8 never clobbers a record.
