# Extension review — 0.7.1

This review covered the current implementation, architectural boundaries,
concurrency, review-state transfer, ignore eligibility, persistence, terminal
delivery, tests, dependencies, and VSIX contents. Publication identity is outside
this review's scope.

## Correctness and safety fixes

| Problem | Resolution and evidence |
| --- | --- |
| Blame ignored continuation blocks and SHA-256 repository commits. | Parse one content line per porcelain block with optional group count. Real SHA-1 and SHA-256 repositories test multiline attribution. |
| User Git inter-hunk settings made unchanged lines reviewable. | Explicit `--inter-hunk-context=0` preserves zero-context hunk semantics. Regression sets a conflicting real Git configuration. |
| Ambiguous duplicate additions could become reviewed through blame. | Existing ambiguous digests stay pending; blame only initializes genuinely new additions. |
| Concurrent tracking-target updates overwrote each other or raced opt-out. | Serialize initialization updates. Concurrent additions and disable/inclusion ordering are verified after reloading disk state. |
| Ignore edits arriving during refresh were dropped. | Run a serialized trailing refresh, including after a failed earlier pass. Barrier-based event tests cover both cases. |
| File creation could reuse discovery begun before the new file existed. | Forced invalidation waits for the older scan and performs a fresh coalesced scan. The deterministic regression failed before this fix. |
| Nested workspace roots could misattribute files and ignore rules. | Discovery only admits results owned by the requested workspace root. Tests verify parent/child isolation. |
| Ignore cleanup bypassed source-operation serialization. | Queue deletion with source writes, then recheck current rules. Tests cover competing writes, re-inclusion, and ignore-check failure. |
| Concurrent worker failure returned while sibling effects continued. | Stop scheduling, drain active work, then propagate the first error. Deterministic barriers verify failure lifetime and concurrency limits. |
| Concurrent RevExt ignore commands lost shared configuration entries. | Serialize read/modify/write operations; preserve unrelated keys and reject malformed or unsaved configuration. Command tests cover failure recovery. |
| Workspace-root RevExt exclusion did not work. | Support `.` as a root folder exclusion, including the root-folder command. |
| Large terminal selections exceeded JavaScript's argument limit. | Compute fence length iteratively. A 300,000-character selection provides regression coverage. |
| Sending source text to a terminal could execute it in a shell without a warning. | Require explicit confirmation before terminal creation, command startup, or text delivery. A disposable Bash reproduction demonstrated execution of the original payload; cancellation and trust behavior have command-level tests. |
| Queued decoration refreshes accessed disposed resources. | Cancel scheduled UI work on disposal; test cache invalidation, refresh coalescing, and disposal. |

## Architecture and optimization

The existing domain/application/adapter separation was retained and tightened.
Blame attribution types now belong to the domain rather than the Git adapter.
Lint enforces domain import boundaries. Cleanup and UI consumers declare the
small service interfaces they actually need; unused duplicate interfaces and a
dead decoration helper were removed.

The tree has one typed grouped cache instead of redundant cached state and
unsafe casts. It sorts derived groups without mutating service summaries.
Discovery and watcher bursts share work while preserving the required fresh
pass. Concurrency remains bounded and now has a reliable failure lifetime.
Policy-only refreshes of unchanged content skip blame and identity subprocesses;
empty-baseline records also skip snapshot reads, diffs, and redundant commits.
Five regressions verify preserved decisions and normal changed-content blame.
These changes improve maintainability and eliminate redundant work; no broad
performance claim is made without a workload benchmark.

`ARCHITECTURE.md` records dependency direction, state ownership, queue boundaries,
failure behavior, and the saved-content authority. Repository settings exclude
implementation and test files from automatic RevExt annotation during
self-hosted development.

## Test and dependency findings

The previous blame fixture did not model real porcelain continuation blocks.
It has been corrected and backed by real Git subprocess tests. The browser test
previously skipped an unavailable or unusable browser; it now fails, with bounded
browser process timeouts. Forbidden-write watchers previously observed obsolete
repository storage; they now observe active extension storage, including
transient writes. Failed integration runs retain fixtures and logs for diagnosis.

A later full run exposed a false snapshot failure during promotion: the test
combined metadata and a snapshot-directory listing taken at different times.
The preserved final store had 20 valid records, every referenced snapshot passed
digest/size validation, and there were no orphans. The assertion now reads and
verifies the referenced gzip directly. The workspace-wide policy test uses a
bounded deadline proportional to its fixture population rather than applying
one file's deadline to the entire workspace; persistence checks remain intact.

The initial development dependency audit reported 12 advisories across
`brace-expansion`, `fast-uri`, `js-yaml`, and `qs`. Only their compatible
transitive versions were updated, with installation scripts disabled. The
subsequent full audit reported **zero known advisories** across 462 dependencies;
the runtime-only audit also reported zero. An audit result is time-specific and
does not prove the absence of undisclosed vulnerabilities.

The VSIX now uses an explicit file allowlist. It excludes unrelated tutorials,
development configuration, lockfiles, tests, and stale source maps. The bundled
`ignore` dependency's license is retained in `THIRD_PARTY_NOTICES.md`. Manifest
version is 0.7.1; the runtime reads its version from that manifest.
The verified archive is 48,681 bytes, down from the existing 0.7.0 artifact's
128,510 bytes (about 62% smaller), with nine archive entries.

The installed `vsce` CLI invokes the prepublish hook through another package
manager even when launched by pnpm. The packaging script now builds with pnpm,
stages only allowlisted files, and removes that redundant hook only from the
staged manifest before invoking the public packaging API. The working-tree
manifest remains intact and temporary staging is cleaned in `finally`.

## Remaining limitations

**Automatic RevExt comments remain a material source-semantics risk.** The
documented policy emits direct suffixes without a language-context parser. In
JSX these can become rendered text; inside multiline strings or heredocs they
can alter program data or syntax. The browser test intentionally verifies the
documented rendered-marker behavior, so a passing result is not proof of semantic
transparency. This policy was preserved rather than silently removing an
existing capability. To avoid automatic source mutation, use
`{"revExtIgnoredFolders":["."]}` in `.vscode/review-extension.json`. A universally
transparent annotation strategy requires a separate design decision.

Terminal confirmation makes the execution risk explicit; it does not turn a
shell into a safe agent-input channel. The terminal's foreground program remains
the user's responsibility.

Other preserved boundaries: startup/diff display may miss a same-size,
same-mtime rewrite until a forced reconciliation; selected initialization files
are seeds rather than permanent exclusions; pure-deletion attribution remains
conservative. No Windows/macOS, remote-host, or large-workspace performance
certification is claimed by this Linux validation run.

## Final validation

- Type checking and lint: passed, including the domain import rule and packaging
  script syntax check.
- Unit tests: **145 passed, zero failures, zero skips**.
- Real browser rendering: passed, zero skips.
- Extension Host: enabled lifecycle, restart, and disabled-workspace suites all
  passed. The final aggregate command
  `pnpm --config.verify-deps-before-run=false test` exited successfully.
- Dependency audit: zero advisories, including development dependencies.
- `pnpm run package:vsix`: passed through the pnpm-only staging workflow.
- Archive inspection: exact nine-entry allowlist, version 0.7.1 in both
  manifests, runtime byte-for-byte equal to the build, and third-party notice
  present. Only the staged prepublish hook differs from the source manifest.
- `git diff --check`: passed.

Artifact: `code-review-tracker-0.7.1.vsix`.
SHA-256: `40a9751d0257988dc045a3393199d974c53b2e4412d3122a4c084a5813953379`.
