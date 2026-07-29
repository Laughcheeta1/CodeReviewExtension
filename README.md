# Code Review Tracker

Code Review Tracker adds saved-file, line-level review state to VS Code. It compares each file with a reviewed baseline, shows the result in VS Code's native diff editor, and persists decisions with the workspace.

## Use

Git must be installed. The extension uses `git diff --no-index` as its local diff engine; it does not synchronize branches, pulls, commits, authors, or other collaborators.

On first activation, choose whether to initialize Code Review Tracker for that repository. Choosing **Never Initialize** records the opt-out in the repository and prevents future automatic initialization prompts. If you choose **Initialize**, a multi-select checklist opens with every candidate file selected. Use the Select All or Deselect All buttons, then check only the files you want to track before choosing:

- **Start Reviewed** to snapshot the selected eligible saved files as their reviewed baseline.
- **Start Pending** to use an empty baseline, making every selected saved line an addition awaiting review.

When a `.gitignore` exists, the checklist contains Git-tracked files; otherwise it contains all workspace files. When an ignore file changes, the review list refreshes and removes any newly ignored review state.

Dismissing a setup step leaves the workspace untouched and shows the initialization prompt again on the next activation.
To resume setup without restarting VS Code, run **Code Review: Set Up Tracking** from the Command Palette.
Running it again reconfigures the repository. **Code Review: Mark Entire Workspace Pending** and **Code Review: Mark Entire Workspace Reviewed** explicitly replace the current selection with the entire workspace, including eligible files added later.

Open **Code Review: Open Review Diff** or select a file in the Code Review sidebar. The compressed baseline appears on the left and the saved source file on the right.

- Git additions are reviewed on the right.
- Git deletions are reviewed on the left.
- A replacement remains one deletion plus one addition; the extension does not guess that they form a “modified” line.
- Use the line commands for selections or the CodeLens actions for an entire Git hunk. In the Explorer, right-click a tracked file to mark all of its reviewable changes as pending, in review, or reviewed.
- To send the current editor selection to an agent, use **Send Selection to Agent** from the editor right-click menu or <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd>.
- Lines that contain only a line ending are ignored; whitespace-only lines still count. LF, CRLF, and missing-final-newline identity are preserved.
- The default shortcuts are <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd> for pending review, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>K</kbd> for in review, and <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>L</kbd> for reviewed. Rebind them in **Preferences: Open Keyboard Shortcuts**.
- Unsaved editors cannot be reviewed. Save first so disk content remains authoritative.
- Only duplicate added lines receive a temporary `RevExt` end-of-line comment. The complete tagged line becomes its identity, so later insertions do not disturb the review state of its duplicate peers. The comments are removed when the file is promoted.

When every addition and deletion is reviewed, the saved file is automatically promoted to the next baseline and its obsolete diff tab closes.

Shared state lives under:

```text
.vscode/code-review-tracker/
  initialization.json
  <path-hash>.json
  snapshots/
    <path-hash>.<baseline-digest>.gz
```

Version 0.4.0 does not migrate older metadata. The tracker directory is reset only after an initialization choice is made.

At startup, stored filesystem mtime and size avoid unnecessary reads and Git diffs. Before review actions, the exact saved-file digest is still verified so this optimization cannot authorize stale review state. The rationale is documented in the architecture guide.

## Development

Run:

```bash
npm ci
npm test
npm run package:vsix
```

The aggregate test runs type checking, linting, unit tests, and the Extension Host smoke test. See [ARCHITECTURE.md](ARCHITECTURE.md) for the component, design, and manual verification checks.
