# Task overview

Keep automatic review-view opening for files the user opens manually, while
preventing agent/extension-driven file reconciliation and marker maintenance
from opening the changed file or its review diff.

# Goals

- Preserve `codeReviewTracker.openFilesInReviewView` as the opt-in/opt-out
  setting for user-visible file opens.
- Prevent extension-owned `openTextDocument` calls used by RevExt annotation and
  review mutations from triggering the review view.
- Still open the review view when a file that was previously loaded internally
  is later made visible by the user, even though VS Code may not emit a second
  `onDidOpenTextDocument` event.
- Preserve all existing reconciliation, annotation, dirty-buffer, ignore-rule,
  and native-diff behavior.

# Implementation details

1. Add an internal-document-load registry to `ReviewService`. The wrapper used
   for extension-owned `openTextDocument` calls will return already-loaded
   documents, mark newly or hidden-internally-loaded documents as pending for a
   future manual visible open, and clear the marker on failure or document
   close.
2. Route all three extension-owned source-document loads through the wrapper:
   external RevExt language detection, pending-file annotation, and promotion
   marker removal. The wrapper must not mark a document that is already visible.
3. Change the `onDidOpenTextDocument` lifecycle callback to ignore documents
   marked as internally loaded. Extend the existing visible-editor lifecycle
   callback with a helper that consumes a pending internal marker only when the
   source is visibly opened outside a native review diff, then calls the current
   `openDocumentInReviewView` path. Keep the existing setting check in
   `review-commands.ts` unchanged.
4. Add Extension Host coverage for a closed tracked source: perform a host
   filesystem write that causes annotation/reconciliation, assert that no
   review diff tab opens, then manually show the same source and assert that a
   review diff opens when the setting is true. Add the false-setting assertion
   that neither path opens a review view.
5. Update the architecture wording to document that internal document loads do
   not open review views while later user-visible opens still honor the setting.
6. After implementation approval, run focused and complete verification,
   synchronize the extension version, and package/inspect a VSIX as required by
   the repository lessons.

# Kanban List

- [Done] Read `ARCHITECTURE.md` and trace the current open/reconciliation paths.
- [Done] Identify all extension-owned `openTextDocument` call sites.
- [Done] Specify the internal-load registry and visible/manual-open handoff.
- [Done] Implement the lifecycle and context changes.
- [Done] Add regression coverage and update architecture documentation.
- [Done] Run verification, synchronize versions, and package the extension.

# Findings

- `src/extension.ts:96-102` invokes `openDocumentInReviewView` for every
  `onDidOpenTextDocument` event.
- `src/revext-annotation.ts:345` is reached by external-file reconciliation and
  calls `vscode.workspace.openTextDocument` when the changed source is not
  already loaded. The same file opens documents for pending annotation, and
  `src/review-mutations.ts:204` opens one during promotion.
- `src/review-commands.ts:81-92` already honors
  `codeReviewTracker.openFilesInReviewView`; the setting should remain in this
  existing boundary rather than be changed to disable the feature globally.
- Suppressing only the open event is insufficient: once an internal load has
  populated `workspace.textDocuments`, a later manual display may not emit a
  second `onDidOpenTextDocument`. A pending marker consumed by visible-editor
  events is required to preserve the requested manual behavior.
- The first integration attempt exposed a timing race while a native diff tab
  was being registered. The visible-editor handoff now waits one event-loop
  turn and requires a normal `TabInputText` tab before consuming the marker, so
  explicit diff openings cannot recursively trigger another review diff.
- The integration test temporarily changes `openFilesInReviewView` at global
  scope inside the isolated test user data. Using workspace scope would create
  `.vscode/settings.json`, which is correctly discovered as an eligible source
  and would contaminate the expected metadata inventory.
- Verification passed: lint/integration syntax checks, 29 unit tests, the
  browser test, and the complete contract/restart/disabled Extension Host
  suites. Version `0.5.21` is synchronized between `package.json` and
  `src/extension.ts`; the packaged artifact is
  `code-review-tracker-0.5.21.vsix` and its embedded manifest reports
  `0.5.21`.
