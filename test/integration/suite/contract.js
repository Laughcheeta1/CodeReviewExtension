const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const {
  mkdir,
  readFile: readPhysicalFile,
  writeFile: writePhysicalFile,
} = require("node:fs/promises");
const { dirname, join } = require("node:path");
const { promisify } = require("node:util");
const vscode = require("vscode");
const {
  assertAbsentDuring,
  assertMetadataMissing,
  assertMetadataPresent,
  assertMetadataPaths,
  assertNoExplicitTarget,
  assertNoUnknownTrackerEntries,
  assertSnapshotPresent,
  readInventory,
  waitForMetadata,
  waitForMetadataMissing,
  waitUntil,
  watchForbiddenPaths,
} = require("./inventory");

const encoder = new TextEncoder();
const execute = promisify(execFile);

/*
 * This suite intentionally contains one long, ordered scenario. The order is
 * part of the contract: it starts with sources that exist before activation,
 * then exercises every lifecycle event while VS Code is alive, then changes
 * ignore rules and finally exercises folder and workspace commands. Every
 * operation is followed by an on-disk assertion so a passing command alone can
 * never conceal a missing or forbidden record.
 */

function sourceUri(folder, relativePath) {
  return vscode.Uri.joinPath(folder.uri, ...relativePath.split("/"));
}

async function writeSource(folder, relativePath, content) {
  const uri = sourceUri(folder, relativePath);
  await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
  return uri;
}

async function writeExternalSource(folder, relativePath, content) {
  const absolute = join(folder.uri.fsPath, ...relativePath.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writePhysicalFile(absolute, content);
}

async function rewriteIgnoreFile(folder, removePaths) {
  const uri = sourceUri(folder, ".gitignore");
  const current = new TextDecoder().decode(
    await vscode.workspace.fs.readFile(uri),
  );
  const removed = new Set(removePaths);
  const next = current
    .split(/\r?\n/)
    .filter((line) => !removed.has(line))
    .join("\n");
  await vscode.workspace.fs.writeFile(uri, encoder.encode(next));
}

async function appendIgnoreRules(folder, rules, options = {}) {
  const ignoreUri = sourceUri(folder, ".gitignore");
  const current = new TextDecoder().decode(
    await vscode.workspace.fs.readFile(ignoreUri),
  );
  const suffix = current.endsWith("\n") ? "" : "\n";
  await vscode.workspace.fs.writeFile(
    ignoreUri,
    encoder.encode(`${current}${suffix}${rules.join("\n")}\n`),
  );
  if (options.refresh !== false) {
    // Some callers deliberately omit this command to verify the .gitignore
    // watcher itself. When requested, make the rule change observable before
    // the next create/open/command step; the extension must still apply the
    // same guard at each individual event.
    await vscode.commands.executeCommand("codeReviewTracker.refresh");
  }
}

async function replaceIgnoreRules(folder, content) {
  await vscode.workspace.fs.writeFile(
    sourceUri(folder, ".gitignore"),
    encoder.encode(content),
  );
}

async function openSource(folder, relativePath) {
  const document = await vscode.workspace.openTextDocument(
    sourceUri(folder, relativePath),
  );
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

async function waitForReviewDiff(folder, relativePath) {
  return waitUntil(`review diff for ${relativePath}`, () =>
    findReviewDiff(folder, relativePath) ?? false,
  );
}

function findReviewDiff(folder, relativePath) {
  const modified = sourceUri(folder, relativePath).toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.modified.toString() === modified &&
        tab.input.original.scheme === "code-review-baseline"
      ) {
        return tab;
      }
    }
  }
  return undefined;
}

async function assertNoReviewDiffDuring(
  folder,
  relativePath,
  context,
) {
  const deadline = Date.now() + 1_000;
  while (true) {
    assert.equal(
      findReviewDiff(folder, relativePath),
      undefined,
      `${context} unexpectedly opened a review diff`,
    );
    if (Date.now() >= deadline) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function focusReviewDiffSide(tab, uri) {
  const existing = vscode.window.visibleTextEditors.find(
    (editor) => editor.document.uri.toString() === uri.toString(),
  );
  const document =
    existing?.document ?? (await vscode.workspace.openTextDocument(uri));
  return vscode.window.showTextDocument(document, {
    viewColumn: tab.group.viewColumn,
    preserveFocus: false,
  });
}

async function closeAllTabs() {
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs, true);
  }
}

async function assertForbidden(folder, paths, watcher, context) {
  for (const relativePath of paths) {
    await assertMetadataMissing(folder, relativePath, context);
    await assertNoExplicitTarget(folder, relativePath, context);
  }
  watcher.assertNoForbiddenEvents(context);
}

async function settleForbidden(folder, paths, watcher, context) {
  await assertAbsentDuring(folder, paths, {
    context,
    durationMs: 1_000,
    intervalMs: 50,
  });
  await assertForbidden(folder, paths, watcher, context);
}

async function markFile(folder, relativePath, command) {
  await vscode.commands.executeCommand(
    command,
    sourceUri(folder, relativePath),
  );
}

async function markActive(folder, relativePath, command, line = 0) {
  const document = await openSource(folder, relativePath);
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor, "an editor must be active for line-level commands");
  assert.equal(editor.document.uri.toString(), document.uri.toString());
  editor.selection = new vscode.Selection(line, 0, line, 0);
  await vscode.commands.executeCommand(command);
}

async function setGitIdentity(folder, name, email) {
  await execute("git", ["-C", folder.uri.fsPath, "config", "user.name", name]);
  await execute("git", ["-C", folder.uri.fsPath, "config", "user.email", email]);
}

async function assertStatus(folder, relativePath, status) {
  const value = await assertMetadataPresent(folder, relativePath, { status });
  assert.equal(value.file.fileStatus, status);
  return value;
}

async function assertMetadataStableDuring(
  folder,
  relativePath,
  expected,
  context,
) {
  const deadline = Date.now() + 1_000;
  do {
    const value = await assertMetadataPresent(folder, relativePath);
    assert.equal(
      value.file.current.digest,
      expected.file.current.digest,
      `${context} changed the persisted current digest`,
    );
    assert.equal(
      value.file.updatedAt,
      expected.file.updatedAt,
      `${context} changed persisted metadata for a dirty buffer`,
    );
    assert.deepEqual(
      value.file.currentLines,
      expected.file.currentLines,
      `${context} changed persisted current line records`,
    );
    assert.deepEqual(
      value.file.deletedLines,
      expected.file.deletedLines,
      `${context} changed persisted deleted line records`,
    );
    assert.deepEqual(
      value.file.hunks,
      expected.file.hunks,
      `${context} changed persisted hunks`,
    );
    if (Date.now() >= deadline) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (true);
}

async function assertNoReservedRecords(folder) {
  const inventory = await readInventory(folder);
  for (const entry of inventory.metadata) {
    const storedPath = entry.value.path;
    assert.equal(
      storedPath === ".git" ||
        storedPath.startsWith(".git/") ||
        storedPath === "node_modules" ||
        storedPath.startsWith("node_modules/") ||
        storedPath === ".vscode/code-review-tracker" ||
        storedPath.startsWith(".vscode/code-review-tracker/"),
      false,
      `Reserved workspace data was persisted as review metadata: ${storedPath}`,
    );
  }
}

async function assertEnabledInitialization(folder, context) {
  const inventory = await readInventory(folder);
  assert.equal(
    inventory.initialization?.schemaVersion,
    1,
    `${context} initialization configuration has the wrong schema version`,
  );
  assert.equal(
    inventory.initialization?.state,
    "initialized",
    `${context} workspace is no longer enabled for tracking`,
  );
  assert.ok(
    inventory.initialization.targets?.some(
      (target) => target.kind === "folder" && target.path === "",
    ),
    `${context} initialization lost the configured workspace target`,
  );
}

async function run() {
  const extension = vscode.extensions.getExtension("local.code-review-tracker");
  assert.ok(extension, "the development extension must be available");
  await extension.activate();
  const reviewerConfiguration = vscode.workspace.getConfiguration(
    "codeReviewTracker",
  );
  await reviewerConfiguration.update(
    "reviewerName",
    "Fallback Reviewer",
    vscode.ConfigurationTarget.Global,
  );
  await reviewerConfiguration.update(
    "reviewerEmail",
    "fallback@example.test",
    vscode.ConfigurationTarget.Global,
  );
  assert.equal(extension.isActive, true);
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the integration workspace must be available");

  const files = {
    tracked: "tracked.txt",
    untracked: "untracked.txt",
    nested: "nested/eligible.txt",
    nestedIgnore: "nested/.gitignore",
    nestedIgnored: "nested/nested-ignored.txt",
    nestedAllowed: "nested/nested-allowed.txt",
    ignoredRoot: "ignored-root.txt",
    ignoredAfterActivation: "ignored-after-activation.txt",
    ignoredNested: "ignored-folder/hidden.txt",
    ignoredAllowed: "ignored-folder/allowed.txt",
    secret: "credentials.secret",
    allowedSecret: "allowed.secret",
    rootOnly: "root-only.txt",
    nestedRootOnly: "nested/root-only.txt",
    infoExcluded: "info-excluded.txt",
    forceAddedSecret: "force-added.secret",
    externalIgnored: "external-ignored.txt",
    ignoredBeforeRestart: "ignored-before-restart.txt",
    openFallback: "open-fallback.txt",
    fileCommandFallback: "file-command-fallback.txt",
    lineCommandFallback: "line-command-fallback.txt",
    diffFallback: "diff-fallback.txt",
    fallbackFolder: "fallback-folder",
    fallbackFolderFile: "fallback-folder/source.txt",
    dynamicIgnored: "dynamic-ignored.txt",
    dynamicFolderFile: "dynamic-folder/source.txt",
    liveLeftDiff: "live-left-diff.txt",
    externalRevExt: "external-agent-duplicate.ts",
    deletedBeforeRestart: "deleted-before-restart.txt",
    protectedDependency: "node_modules/protected.js",
  };
  const alwaysForbidden = [
    files.ignoredRoot,
    files.ignoredAfterActivation,
    files.ignoredBeforeRestart,
    files.ignoredNested,
    files.nestedIgnored,
    files.secret,
    files.forceAddedSecret,
    files.externalIgnored,
    files.dynamicIgnored,
    files.dynamicFolderFile,
    files.protectedDependency,
  ];
  const watcher = watchForbiddenPaths(folder, alwaysForbidden);
  const fallbackWatcher = watchForbiddenPaths(folder, [
    files.openFallback,
    files.fileCommandFallback,
    files.lineCommandFallback,
    files.diffFallback,
    files.fallbackFolderFile,
  ]);
  const expectedPaths = new Set([
    ".gitignore",
    files.tracked,
    files.untracked,
    files.nested,
    files.nestedIgnore,
    files.nestedAllowed,
    files.infoExcluded,
    files.ignoredAllowed,
    files.allowedSecret,
    files.nestedRootOnly,
    files.liveLeftDiff,
    files.externalRevExt,
    files.deletedBeforeRestart,
  ]);

  try {
    /*
     * Startup/enumeration contract. The fixture stages only tracked.txt and
     * .gitignore. Every other nonignored source below is deliberately absent
     * from the index; metadata must still exist for all of them. Conversely,
     * ignored files include an ignored directory child, a glob match, an
     * anchored rule, a nested .gitignore rule, and a force-added index entry.
     * The .git/info/exclude entry is intentionally eligible because it is
     * outside the extension's ignore-rule inputs.
     */
    for (const relativePath of [
      files.tracked,
      files.untracked,
      files.nested,
      files.ignoredAllowed,
      files.allowedSecret,
      files.nestedRootOnly,
      files.liveLeftDiff,
      files.deletedBeforeRestart,
    ]) {
      await waitForMetadata(folder, relativePath, { timeoutMs: 8_000 });
    }
    await assertMetadataPaths(folder, expectedPaths, "startup");
    await assertEnabledInitialization(folder, "startup");
    await settleForbidden(folder, alwaysForbidden, watcher, "startup");
    await assertNoReservedRecords(folder);

    /*
     * The generated metadata must be semantically valid, not merely present:
     * the stored current digest has to match the source bytes and the
     * content-addressed baseline snapshot must exist. This checks both staged
     * and untracked eligible files.
     */
    const trackedRecord = await assertMetadataPresent(folder, files.tracked);
    await assertSnapshotPresent(
      folder,
      trackedRecord.file.baseline.file,
      "startup baseline",
    );
    await assertNoUnknownTrackerEntries(folder);

    /*
     * An open diff keeps the original baseline URI, including the current
     * digest from the generation that was opened. The modified side must be
     * able to advance through multiple current-file edits without making a surviving
     * deleted baseline line unreviewable. A deleted line that is restored
     * before the action must instead become a safe no-op.
    */
    const liveLeftDiff = files.liveLeftDiff;
    await waitForMetadata(folder, liveLeftDiff);
    await markFile(
      folder,
      liveLeftDiff,
      "codeReviewTracker.markFileReviewed",
    );
    const liveLeftReviewed = await assertStatus(
      folder,
      liveLeftDiff,
      "reviewed",
    );
    assert.equal(
      liveLeftReviewed.file.baseline.digest,
      liveLeftReviewed.file.current.digest,
      "the live-diff fixture must begin from a reviewed baseline",
    );
    await writeExternalSource(folder, liveLeftDiff, "before\nafter\n");
    await vscode.commands.executeCommand("codeReviewTracker.refresh");
    await waitUntil("initial deleted line for live diff", async () => {
      const value = await assertMetadataPresent(folder, liveLeftDiff);
      return value.file.deletedLines.length === 1 &&
        value.file.deletedLines[0]?.baselineLine === 2
        ? value
        : false;
    });
    await closeAllTabs();
    await vscode.commands.executeCommand(
      "codeReviewTracker.openReviewDiff",
      sourceUri(folder, liveLeftDiff),
    );
    const liveLeftTab = await waitForReviewDiff(folder, liveLeftDiff);
    assert.ok(liveLeftTab.input instanceof vscode.TabInputTextDiff);
    const originalBaselineUri = liveLeftTab.input.original;
    const originalDiffCurrentDigest = new URLSearchParams(
      originalBaselineUri.query,
    ).get("current");
    assert.ok(originalDiffCurrentDigest, "the diff must carry its opened digest");

    await writeExternalSource(
      folder,
      liveLeftDiff,
      "new top\nbefore\nafter\n",
    );
    await vscode.commands.executeCommand("codeReviewTracker.refresh");
    await writeExternalSource(
      folder,
      liveLeftDiff,
      "new top\nbefore\nnew bottom\nafter\n",
    );
    await vscode.commands.executeCommand("codeReviewTracker.refresh");
    const liveLeftAfterEdits = await waitUntil(
      "latest current generation for live diff",
      async () => {
        const value = await assertMetadataPresent(folder, liveLeftDiff);
        const added = value.file.currentLines.filter(
          (line) => line.changeType === "added",
        );
        return added.length === 2 &&
          value.file.deletedLines.length === 1 &&
          value.file.deletedLines[0]?.baselineLine === 2
          ? value
          : false;
      },
    );
    assert.notEqual(
      originalDiffCurrentDigest,
      liveLeftAfterEdits.file.current.digest,
      "the test must exercise a diff whose opened current digest is stale",
    );

    const leftEditor = await focusReviewDiffSide(
      liveLeftTab,
      originalBaselineUri,
    );
    leftEditor.selection = new vscode.Selection(1, 0, 1, 0);
    for (const [command, status] of [
      ["codeReviewTracker.markInReview", "inReview"],
      ["codeReviewTracker.markPending", "pending"],
      ["codeReviewTracker.markReviewed", "reviewed"],
    ]) {
      await vscode.commands.executeCommand(command);
      await waitUntil(
        `left-side ${status} action after current edits`,
        async () => {
          const value = await assertMetadataPresent(folder, liveLeftDiff);
          return value.file.deletedLines.length === 1 &&
            value.file.deletedLines[0]?.baselineLine === 2 &&
            value.file.deletedLines[0]?.reviewStatus === status
            ? value
            : false;
        },
      );
    }
    const reviewedDeletedLine = await assertMetadataPresent(
      folder,
      liveLeftDiff,
    );
    assert.equal(
      reviewedDeletedLine.file.baseline.digest,
      liveLeftAfterEdits.file.baseline.digest,
      "reviewing the left side must not replace the immutable baseline",
    );
    assert.deepEqual(
      reviewedDeletedLine.file.currentLines
        .filter((line) => line.changeType === "added")
        .map((line) => line.reviewStatus),
      ["pending", "pending"],
    );

    await writeExternalSource(
      folder,
      liveLeftDiff,
      "new top\nbefore\nremove me\nnew bottom\nafter\n",
    );
    await vscode.commands.executeCommand("codeReviewTracker.refresh");
    const restoredCurrent = await waitUntil(
      "deleted line removal from the latest diff",
      async () => {
        const value = await assertMetadataPresent(folder, liveLeftDiff);
        return value.file.deletedLines.length === 0 ? value : false;
      },
    );
    const staleLeftEditor = await focusReviewDiffSide(
      liveLeftTab,
      originalBaselineUri,
    );
    staleLeftEditor.selection = new vscode.Selection(1, 0, 1, 0);
    await vscode.commands.executeCommand("codeReviewTracker.markReviewed");
    const afterRemovedTarget = await assertMetadataPresent(
      folder,
      liveLeftDiff,
    );
    assert.equal(
      afterRemovedTarget.file.current.digest,
      restoredCurrent.file.current.digest,
      "a disappeared deleted line action must not create another generation",
    );
    assert.deepEqual(
      afterRemovedTarget.file.deletedLines,
      [],
      "a restored baseline line must not remain reviewable through the old diff",
    );
    expectedPaths.add(liveLeftDiff);
    await closeAllTabs();

    /*
     * A coding agent can rewrite a source through the host filesystem while
     * no source editor is visible. The external watcher must both persist the
     * Git diff and add RevExt identities; no TextDocument.save() is used for
     * either host write below. The second write happens while the native diff
     * is open so the live review view is covered too.
     */
    const externalRevExt = files.externalRevExt;
    await reviewerConfiguration.update(
      "openFilesInReviewView",
      true,
      vscode.ConfigurationTarget.Global,
    );
    await waitForMetadata(folder, externalRevExt);
    await markFile(
      folder,
      externalRevExt,
      "codeReviewTracker.markFileReviewed",
    );
    const externalRevExtBaseline = await assertStatus(
      folder,
      externalRevExt,
      "reviewed",
    );
    assert.equal(
      externalRevExtBaseline.file.baseline.digest,
      externalRevExtBaseline.file.current.digest,
      "the external RevExt fixture must begin from a promoted reviewed baseline",
    );
    await closeAllTabs();
    assert.equal(
      vscode.window.visibleTextEditors.some(
        (editor) =>
          editor.document.uri.toString() ===
          sourceUri(folder, externalRevExt).toString(),
      ),
      false,
      "the external RevExt write must begin without a visible source editor",
    );

    await writeExternalSource(
      folder,
      externalRevExt,
      "anchor\nrepeat\nrepeat\n",
    );
    const firstExternalRevExt = await waitUntil(
      "RevExt comments after an external duplicate write",
      async () => {
        const value = await assertMetadataPresent(folder, externalRevExt);
        const added = value.file.currentLines.filter(
          (line) => line.changeType === "added",
        );
        if (added.length !== 2) {
          return false;
        }
        assert.deepEqual(
          added.map((line) => ({
            line: line.line,
            reviewStatus: line.reviewStatus,
          })),
          [
            { line: 2, reviewStatus: "pending" },
            { line: 3, reviewStatus: "pending" },
          ],
        );
        const source = new TextDecoder().decode(
          await readPhysicalFile(
            join(folder.uri.fsPath, externalRevExt),
          ),
        );
        const lines = source.split(/\r?\n/);
        assert.equal(
          (source.match(/\/\/ RevExt:/g) ?? []).length,
          2,
          "external duplicate additions must receive exactly two RevExt comments",
        );
        assert.doesNotMatch(lines[0] ?? "", /RevExt:/);
        assert.match(lines[1] ?? "", /RevExt:/);
        assert.match(lines[2] ?? "", /RevExt:/);
        assert.equal(value.file.fileStatus, "pending");
        assert.equal(value.file.hunks.length, 1);
        assert.equal(value.file.hunks[0]?.newStart, 2);
        assert.equal(value.file.hunks[0]?.newCount, 2);
        return value;
      },
    );
    assert.notEqual(
      firstExternalRevExt.file.current.digest,
      firstExternalRevExt.file.baseline.digest,
      "the external duplicate write must remain a real review diff",
    );
    await assertNoReviewDiffDuring(
      folder,
      externalRevExt,
      "an external agent write",
    );
    assert.ok(
      vscode.workspace.textDocuments.some(
        (document) =>
          document.uri.toString() === sourceUri(folder, externalRevExt).toString(),
      ),
      "the external reconciliation should load the source without showing it",
    );

    await closeAllTabs();
    await openSource(folder, externalRevExt);
    const manuallyOpenedExternalRevExtTab = await waitForReviewDiff(
      folder,
      externalRevExt,
    );
    assert.ok(
      manuallyOpenedExternalRevExtTab.input instanceof vscode.TabInputTextDiff,
    );
    await closeAllTabs();
    await vscode.commands.executeCommand(
      "codeReviewTracker.openReviewDiff",
      sourceUri(folder, externalRevExt),
    );
    const externalRevExtTab = await waitForReviewDiff(folder, externalRevExt);
    assert.ok(externalRevExtTab.input instanceof vscode.TabInputTextDiff);
    assert.equal(
      externalRevExtTab.input.modified.toString(),
      sourceUri(folder, externalRevExt).toString(),
    );
    assert.equal(externalRevExtTab.input.original.scheme, "code-review-baseline");
    await writeExternalSource(
      folder,
      externalRevExt,
      "anchor\nrepeat\nrepeat\nrepeat\n",
    );
    await waitUntil(
      "RevExt comments after an external duplicate write in an open diff",
      async () => {
        const value = await assertMetadataPresent(folder, externalRevExt);
        const added = value.file.currentLines.filter(
          (line) => line.changeType === "added",
        );
        if (added.length !== 3) {
          return false;
        }
        const source = new TextDecoder().decode(
          await readPhysicalFile(
            join(folder.uri.fsPath, externalRevExt),
          ),
        );
        const lines = source.split(/\r?\n/);
        assert.equal(
          (source.match(/\/\/ RevExt:/g) ?? []).length,
          3,
          "open-diff external additions must preserve and extend RevExt comments",
        );
        assert.doesNotMatch(lines[0] ?? "", /RevExt:/);
        assert.match(lines[1] ?? "", /RevExt:/);
        assert.match(lines[2] ?? "", /RevExt:/);
        assert.match(lines[3] ?? "", /RevExt:/);
        assert.deepEqual(
          added.map((line) => line.reviewStatus),
          ["pending", "pending", "pending"],
        );
        return value;
      },
    );
    assert.equal(
      externalRevExtTab.input.modified.toString(),
      sourceUri(folder, externalRevExt).toString(),
      "the native diff must remain available after the external annotated write",
    );
    await closeAllTabs();
    await reviewerConfiguration.update(
      "openFilesInReviewView",
      false,
      vscode.ConfigurationTarget.Global,
    );
    await writeExternalSource(
      folder,
      externalRevExt,
      "anchor\nrepeat\nrepeat\nrepeat\nrepeat\n",
    );
    await waitUntil(
      "RevExt metadata after disabling automatic review views",
      async () => {
        const value = await assertMetadataPresent(folder, externalRevExt);
        return value.file.currentLines.filter(
          (line) => line.changeType === "added",
        ).length === 4
          ? value
          : false;
      },
    );
    await assertNoReviewDiffDuring(
      folder,
      externalRevExt,
      "an external write with review views disabled",
    );
    await openSource(folder, externalRevExt);
    await assertNoReviewDiffDuring(
      folder,
      externalRevExt,
      "a manual open with review views disabled",
    );
    await reviewerConfiguration.update(
      "openFilesInReviewView",
      true,
      vscode.ConfigurationTarget.Global,
    );
    expectedPaths.add(externalRevExt);
    await closeAllTabs();

    /*
     * Creation watcher contract. A file created after activation must be
     * initialized without any Git-index operation. The paired ignored file is
     * created in the same event window and must produce neither metadata nor a
     * snapshot, including during its temporary-write race window.
     */
    const createdEligible = "created-after-activation.txt";
    const createdIgnored = files.ignoredAfterActivation;
    await appendIgnoreRules(folder, [createdIgnored]);
    watcher.addPath(createdIgnored);
    await writeSource(folder, createdEligible, "created eligible\n");
    await writeSource(folder, createdIgnored, "created ignored\n");
    await waitForMetadata(folder, createdEligible);
    expectedPaths.add(createdEligible);
    await settleForbidden(folder, [createdIgnored], watcher, "creation");

    /*
     * A save that adds RevExt markers is an internal source rewrite. It must
     * preserve decisions made before the rewrite, even when a new line shifts
     * the duplicate additions to different physical line numbers.
     */
    const markerSaveRegression = "marker-save-regression.ts";
    await writeSource(folder, markerSaveRegression, "repeat\nrepeat\n");
    await waitForMetadata(folder, markerSaveRegression);
    await markActive(
      folder,
      markerSaveRegression,
      "codeReviewTracker.markReviewed",
      0,
    );
    const beforeMarkerSave = await assertStatus(
      folder,
      markerSaveRegression,
      "inReview",
    );
    assert.equal(
      beforeMarkerSave.file.currentLines[0]?.reviewStatus,
      "reviewed",
    );
    assert.equal(
      beforeMarkerSave.file.currentLines[1]?.reviewStatus,
      "pending",
    );
    const markerDocument = await openSource(folder, markerSaveRegression);
    const markerEdit = new vscode.WorkspaceEdit();
    markerEdit.insert(
      sourceUri(folder, markerSaveRegression),
      new vscode.Position(markerDocument.lineCount - 1, 0),
      "new repeat\nnew repeat\n",
    );
    assert.equal(await vscode.workspace.applyEdit(markerEdit), true);
    assert.equal(await markerDocument.save(), true);
    const afterMarkerSave = await waitUntil(
      "review decisions after RevExt marker save",
      async () => {
        const value = await assertMetadataPresent(folder, markerSaveRegression);
        const added = value.file.currentLines.filter(
          (line) => line.changeType === "added",
        );
        if (added.length !== 4) {
          return false;
        }
        assert.deepEqual(
          added.map((line) => line.reviewStatus),
          ["reviewed", "pending", "pending", "pending"],
        );
        return value;
      },
    );
    const markerSource = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(sourceUri(folder, markerSaveRegression)),
    );
    assert.equal(
      (markerSource.match(/RevExt:/g) ?? []).length,
      2,
      "save reconciliation must annotate only the newly added duplicates",
    );
    const markerLines = markerSource.split(/\r?\n/);
    assert.doesNotMatch(markerLines[0] ?? "", /RevExt:/);
    assert.doesNotMatch(markerLines[1] ?? "", /RevExt:/);
    assert.match(markerLines[2] ?? "", /RevExt:/);
    assert.match(markerLines[3] ?? "", /RevExt:/);
    assert.equal(afterMarkerSave.file.currentLines.length, 4);
    expectedPaths.add(markerSaveRegression);

    /*
     * A fully reviewed file is promoted to a clean baseline before the user
     * adds two identical lines. The duplicate text intentionally already
     * exists in that baseline, so this covers the real new-addition case
     * rather than merely adding a second pair of pending duplicates.
     */
    const fullyReviewedDuplicate = "fully-reviewed-duplicate.ts";
    await writeSource(folder, fullyReviewedDuplicate, "repeat\nanchor\n");
    await waitForMetadata(folder, fullyReviewedDuplicate);
    await markFile(
      folder,
      fullyReviewedDuplicate,
      "codeReviewTracker.markFileReviewed",
    );
    const reviewedDuplicateBaseline = await assertStatus(
      folder,
      fullyReviewedDuplicate,
      "reviewed",
    );
    assert.equal(
      reviewedDuplicateBaseline.file.baseline.digest,
      reviewedDuplicateBaseline.file.current.digest,
      "the duplicate-line regression must begin from a promoted baseline",
    );
    const fullyReviewedDocument = await openSource(
      folder,
      fullyReviewedDuplicate,
    );
    const firstDuplicateEdit = new vscode.WorkspaceEdit();
    firstDuplicateEdit.insert(
      sourceUri(folder, fullyReviewedDuplicate),
      new vscode.Position(fullyReviewedDocument.lineCount - 1, 0),
      "repeat\n",
    );
    assert.equal(await vscode.workspace.applyEdit(firstDuplicateEdit), true);
    assert.equal(await fullyReviewedDocument.save(), true);
    await waitUntil(
      "first duplicate addition before its peer",
      async () => {
        const value = await assertMetadataPresent(
          folder,
          fullyReviewedDuplicate,
        );
        const added = value.file.currentLines.filter(
          (line) => line.changeType === "added",
        );
        if (added.length !== 1) {
          return false;
        }
        assert.equal(
          (new TextDecoder().decode(
            await vscode.workspace.fs.readFile(
              sourceUri(folder, fullyReviewedDuplicate),
            ),
          ).match(/RevExt:/g) ?? []).length,
          0,
          "a unique first addition should not need a RevExt marker",
        );
        return value;
      },
    );
    const secondDuplicateEdit = new vscode.WorkspaceEdit();
    secondDuplicateEdit.insert(
      sourceUri(folder, fullyReviewedDuplicate),
      new vscode.Position(fullyReviewedDocument.lineCount - 1, 0),
      "repeat\n",
    );
    assert.equal(await vscode.workspace.applyEdit(secondDuplicateEdit), true);
    assert.equal(await fullyReviewedDocument.save(), true);
    const afterFullyReviewedDuplicate = await waitUntil(
      "RevExt comments for duplicate additions to a fully reviewed file",
      async () => {
        const value = await assertMetadataPresent(
          folder,
          fullyReviewedDuplicate,
        );
        const added = value.file.currentLines.filter(
          (line) => line.changeType === "added",
        );
        if (added.length !== 2) {
          return false;
        }
        assert.deepEqual(
          added.map((line) => line.reviewStatus),
          ["pending", "pending"],
        );
        return value;
      },
    );
    assert.equal(afterFullyReviewedDuplicate.file.fileStatus, "pending");
    const fullyReviewedDuplicateSource = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(
        sourceUri(folder, fullyReviewedDuplicate),
      ),
    );
    assert.equal(
      (fullyReviewedDuplicateSource.match(/RevExt:/g) ?? []).length,
      2,
      "a fully reviewed baseline must annotate both identical new lines",
    );
    const fullyReviewedDuplicateLines =
      fullyReviewedDuplicateSource.split(/\r?\n/);
    assert.doesNotMatch(fullyReviewedDuplicateLines[0] ?? "", /RevExt:/);
    assert.doesNotMatch(fullyReviewedDuplicateLines[1] ?? "", /RevExt:/);
    assert.match(fullyReviewedDuplicateLines[2] ?? "", /RevExt:/);
    assert.match(fullyReviewedDuplicateLines[3] ?? "", /RevExt:/);
    expectedPaths.add(fullyReviewedDuplicate);

    /*
     * The file watcher can reconcile a saved external change before the save
     * callback gets the document event. A later save must repair that
     * persisted-but-untagged duplicate state instead of treating it as a
     * reason to skip marker creation.
     */
    const watcherFirstDuplicate = "watcher-first-duplicate.ts";
    await writeSource(folder, watcherFirstDuplicate, "repeat\nanchor\n");
    await waitForMetadata(folder, watcherFirstDuplicate);
    await markFile(
      folder,
      watcherFirstDuplicate,
      "codeReviewTracker.markFileReviewed",
    );
    await assertStatus(folder, watcherFirstDuplicate, "reviewed");
    const watcherFirstDocument = await openSource(
      folder,
      watcherFirstDuplicate,
    );
    const watcherFirstEdit = new vscode.WorkspaceEdit();
    watcherFirstEdit.insert(
      sourceUri(folder, watcherFirstDuplicate),
      new vscode.Position(watcherFirstDocument.lineCount - 1, 0),
      "repeat\nrepeat\n",
    );
    assert.equal(await vscode.workspace.applyEdit(watcherFirstEdit), true);
    assert.equal(watcherFirstDocument.isDirty, true);
    await writeExternalSource(
      folder,
      watcherFirstDuplicate,
      "repeat\nanchor\nrepeat\nrepeat\n",
    );
    await waitUntil(
      "watcher reconciliation before save marker repair",
      async () => {
        const value = await assertMetadataPresent(
          folder,
          watcherFirstDuplicate,
        );
        return value.file.currentLines.filter(
          (line) => line.changeType === "added",
        ).length === 2
          ? value
          : false;
      },
    );
    assert.equal(await watcherFirstDocument.save(), true);
    await waitUntil(
      "save marker repair after watcher reconciliation",
      async () => {
        const source = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(
            sourceUri(folder, watcherFirstDuplicate),
          ),
        );
        return (source.match(/RevExt:/g) ?? []).length === 2
          ? source
          : false;
      },
    );
    expectedPaths.add(watcherFirstDuplicate);

    /*
     * Empty-line deletion policy. The default must preserve the existing
     * review behavior, while enabling the setting must remove a pending blank
     * deletion and promote the accepted current bytes to the baseline.
     */
    const reviewConfiguration = vscode.workspace.getConfiguration(
      "codeReviewTracker",
    );
    assert.equal(
      reviewConfiguration.get("ignoreEmptyLineDeletions", false),
      false,
      "empty-line deletion filtering must be opt-in",
    );
    const savedEmptyLine = "saved-empty-line-deletion.txt";
    await writeSource(folder, savedEmptyLine, "before\n\nafter\n");
    await waitForMetadata(folder, savedEmptyLine);
    await markFile(
      folder,
      savedEmptyLine,
      "codeReviewTracker.markFileReviewed",
    );
    const savedEmptyLineDocument = await openSource(folder, savedEmptyLine);
    const savedEmptyLineEdit = new vscode.WorkspaceEdit();
    savedEmptyLineEdit.delete(
      sourceUri(folder, savedEmptyLine),
      savedEmptyLineDocument.lineAt(1).rangeIncludingLineBreak,
    );
    assert.equal(await vscode.workspace.applyEdit(savedEmptyLineEdit), true);
    assert.equal(await savedEmptyLineDocument.save(), true);
    const defaultDeletion = await waitUntil(
      "default empty-line deletion review record",
      async () => {
        const value = await assertMetadataPresent(folder, savedEmptyLine);
        return value.file.deletedLines.length === 1 ? value : false;
      },
    );
    assert.equal(defaultDeletion.file.fileStatus, "pending");

    await reviewConfiguration.update(
      "ignoreEmptyLineDeletions",
      true,
      vscode.ConfigurationTarget.Global,
    );
    const acceptedSavedEmptyLine = await waitUntil(
      "configured empty-line deletion acceptance",
      async () => {
        const value = await assertMetadataPresent(folder, savedEmptyLine);
        if (
          value.file.baseline.digest !== value.file.current.digest ||
          value.file.deletedLines.length !== 0 ||
          value.file.hunks.length !== 0 ||
          value.file.fileStatus !== "reviewed"
        ) {
          return false;
        }
        return value;
      },
    );
    assert.equal(
      acceptedSavedEmptyLine.file.baseline.size,
      (await vscode.workspace.fs.readFile(
        sourceUri(folder, savedEmptyLine),
      )).byteLength,
      "automatic acceptance must snapshot the current bytes",
    );
    expectedPaths.add(savedEmptyLine);

    /* The same policy must work through the watcher without an open source. */
    const externalEmptyLine = "external-empty-line-deletion.txt";
    await writeSource(folder, externalEmptyLine, "before\n\nafter\n");
    await waitForMetadata(folder, externalEmptyLine);
    await markFile(
      folder,
      externalEmptyLine,
      "codeReviewTracker.markFileReviewed",
    );
    await writeExternalSource(folder, externalEmptyLine, "before\nafter\n");
    const acceptedExternalEmptyLine = await waitUntil(
      "external empty-line deletion acceptance",
      async () => {
        const value = await assertMetadataPresent(folder, externalEmptyLine);
        return value.file.baseline.digest === value.file.current.digest &&
          value.file.deletedLines.length === 0 &&
          value.file.hunks.length === 0
          ? value
          : false;
      },
    );
    assert.equal(acceptedExternalEmptyLine.file.fileStatus, "reviewed");
    expectedPaths.add(externalEmptyLine);

    /* Mixed changes keep real deletions reviewable while hiding only blanks. */
    const mixedEmptyLine = "mixed-empty-line-deletion.txt";
    await writeSource(folder, mixedEmptyLine, "before\n\nremoved\nafter\n");
    await waitForMetadata(folder, mixedEmptyLine);
    await markFile(
      folder,
      mixedEmptyLine,
      "codeReviewTracker.markFileReviewed",
    );
    await writeExternalSource(folder, mixedEmptyLine, "before\nadded\nafter\n");
    const filteredMixed = await waitUntil(
      "mixed empty-line deletion filtering",
      async () => {
        const value = await assertMetadataPresent(folder, mixedEmptyLine);
        const deleted = value.file.deletedLines.map(
          (line) => line.baselineLine,
        );
        const added = value.file.currentLines
          .filter((line) => line.changeType === "added")
          .map((line) => line.line);
        return deleted.length === 1 &&
          deleted[0] === 3 &&
          added.length === 1 &&
          added[0] === 2
          ? value
          : false;
      },
    );
    assert.equal(filteredMixed.file.fileStatus, "pending");
    assert.equal(
      filteredMixed.file.hunks.some(
        (hunk) => hunk.oldStart <= 2 && 2 < hunk.oldStart + hunk.oldCount,
      ),
      false,
      "effective hunks must not cover the ignored blank deletion",
    );

    await reviewConfiguration.update(
      "ignoreEmptyLineDeletions",
      false,
      vscode.ConfigurationTarget.Global,
    );
    const restoredMixed = await waitUntil(
      "empty-line deletion policy disable refresh",
      async () => {
        const value = await assertMetadataPresent(folder, mixedEmptyLine);
        return value.file.deletedLines.length === 2 ? value : false;
      },
    );
    assert.deepEqual(
      restoredMixed.file.deletedLines.map((line) => line.baselineLine),
      [2, 3],
    );
    await reviewConfiguration.update(
      "ignoreEmptyLineDeletions",
      true,
      vscode.ConfigurationTarget.Global,
    );
    await waitUntil(
      "empty-line deletion policy re-enable refresh",
      async () => {
        const value = await assertMetadataPresent(folder, mixedEmptyLine);
        return value.file.deletedLines.length === 1 &&
          value.file.deletedLines[0]?.baselineLine === 3
          ? value
          : false;
      },
    );
    expectedPaths.add(mixedEmptyLine);

    // Repeat the same positive/negative pair through a real host filesystem
    // write. This proves that the extension's VS Code file watcher, rather
    // than only vscode.workspace.fs, discovers files created externally.
    const externallyCreated = "created-by-host-filesystem.txt";
    await writeExternalSource(folder, externallyCreated, "external eligible\n");
    await writeExternalSource(
      folder,
      files.externalIgnored,
      "external ignored\n",
    );
    await waitForMetadata(folder, externallyCreated);
    expectedPaths.add(externallyCreated);
    await settleForbidden(
      folder,
      [files.externalIgnored],
      watcher,
      "external creation",
    );

    /*
     * Persisted filesystem-change reconciliation is deliberately tested as a
     * complete state transition. The first write happens with no source
     * editor or review diff open; the second happens with a review diff open;
     * the dirty-buffer check proves that editor-only content is not persisted;
     * and the final write proves that a real host write is still observed for
    * an open dirty source. Every assertion reads the persisted JSON and its
     * referenced snapshot rather than trusting an event or UI callback.
     */
    await closeAllTabs();
    await markFile(
      folder,
      files.tracked,
      "codeReviewTracker.markFileReviewed",
    );
    const trackedBeforeHostWrite = await assertMetadataPresent(
      folder,
      files.tracked,
    );
    assert.equal(
      trackedBeforeHostWrite.file.baseline.digest,
      trackedBeforeHostWrite.file.current.digest,
      "the external-change fixture must begin from a reviewed baseline",
    );
    assert.ok(
      trackedBeforeHostWrite.file.currentLines.every(
        (line) => line.changeType === "unchanged",
      ),
      "the external-change fixture must begin with unchanged current lines",
    );
    const firstHostContent = "tracked\nhost change one\n";
    await writeExternalSource(folder, files.tracked, firstHostContent);
    const trackedAfterClosedHostWrite = await waitUntil(
      "closed tracked file host-write reconciliation",
      async () => {
        const value = await assertMetadataPresent(folder, files.tracked);
        if (
          value.file.current.digest ===
          trackedBeforeHostWrite.file.current.digest
        ) {
          return false;
        }
        assert.notEqual(
          value.file.updatedAt,
          trackedBeforeHostWrite.file.updatedAt,
          "host-write reconciliation must persist a new metadata generation",
        );
        assert.equal(value.file.currentLines.length, 2);
        assert.deepEqual(
          value.file.currentLines.map((line) => ({
            line: line.line,
            changeType: line.changeType,
            reviewStatus: line.reviewStatus,
          })),
          [
            { line: 1, changeType: "unchanged", reviewStatus: "reviewed" },
            { line: 2, changeType: "added", reviewStatus: "pending" },
          ],
        );
        assert.deepEqual(value.file.deletedLines, []);
        assert.equal(value.file.hunks.length, 1);
        assert.equal(value.file.hunks[0].newStart, 2);
        assert.equal(value.file.hunks[0].newCount, 1);
        assert.equal(value.file.fileStatus, "pending");
        return value;
      },
    );
    assert.notEqual(
      trackedAfterClosedHostWrite.file.current.digest,
      trackedBeforeHostWrite.file.current.digest,
    );

    await vscode.commands.executeCommand(
      "codeReviewTracker.openReviewDiff",
      sourceUri(folder, files.tracked),
    );
    await waitUntil("tracked review diff for host-write test", () =>
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some(
          (tab) =>
            tab.input instanceof vscode.TabInputTextDiff &&
            tab.input.modified.toString() ===
              sourceUri(folder, files.tracked).toString() &&
            tab.input.original.scheme === "code-review-baseline",
        ),
      ),
    );

    const secondHostContent =
      "tracked\nhost change one\nhost change two\n";
    await writeExternalSource(folder, files.tracked, secondHostContent);
    const trackedAfterOpenDiffHostWrite = await waitUntil(
      "open-diff tracked file host-write reconciliation",
      async () => {
        const value = await assertMetadataPresent(folder, files.tracked);
        if (
          value.file.current.digest ===
          trackedAfterClosedHostWrite.file.current.digest
        ) {
          return false;
        }
        assert.notEqual(
          value.file.updatedAt,
          trackedAfterClosedHostWrite.file.updatedAt,
          "open-diff host-write reconciliation must persist a new generation",
        );
        assert.equal(value.file.currentLines.length, 3);
        assert.deepEqual(
          value.file.currentLines.map((line) => ({
            line: line.line,
            changeType: line.changeType,
            reviewStatus: line.reviewStatus,
          })),
          [
            { line: 1, changeType: "unchanged", reviewStatus: "reviewed" },
            { line: 2, changeType: "added", reviewStatus: "pending" },
            { line: 3, changeType: "added", reviewStatus: "pending" },
          ],
        );
        assert.deepEqual(value.file.deletedLines, []);
        assert.equal(value.file.hunks.length, 1);
        assert.equal(value.file.hunks[0].newStart, 2);
        assert.equal(value.file.hunks[0].newCount, 2);
        assert.equal(value.file.fileStatus, "pending");
        return value;
      },
    );

    const trackedDocument = await openSource(folder, files.tracked);
    const dirtyEdit = new vscode.WorkspaceEdit();
    dirtyEdit.insert(
      sourceUri(folder, files.tracked),
      new vscode.Position(trackedDocument.lineCount - 1, 0),
      "dirty editor buffer only\n",
    );
    assert.equal(await vscode.workspace.applyEdit(dirtyEdit), true);
    assert.equal(trackedDocument.isDirty, true);
    assert.equal(
      new TextDecoder().decode(
        await readPhysicalFile(join(folder.uri.fsPath, files.tracked)),
      ),
      secondHostContent,
      "dirty editor content must not be written to the host file",
    );
    await assertMetadataStableDuring(
      folder,
      files.tracked,
      trackedAfterOpenDiffHostWrite,
      "dirty editor-buffer-only edit",
    );

    const finalHostContent =
      "tracked\nhost change one\nhost change two\nhost change three\n";
    await writeExternalSource(folder, files.tracked, finalHostContent);
    const trackedAfterDirtyHostWrite = await waitUntil(
      "dirty-open tracked file host-write reconciliation",
      async () => {
        const value = await assertMetadataPresent(folder, files.tracked);
        if (
          value.file.current.digest ===
          trackedAfterOpenDiffHostWrite.file.current.digest
        ) {
          return false;
        }
        assert.notEqual(
          value.file.updatedAt,
          trackedAfterOpenDiffHostWrite.file.updatedAt,
          "persisted host bytes must reconcile after a dirty buffer edit",
        );
        assert.equal(value.file.currentLines.length, 4);
        assert.equal(value.file.currentLines.at(-1).line, 4);
        assert.equal(value.file.currentLines.at(-1).changeType, "added");
        assert.equal(value.file.currentLines.at(-1).reviewStatus, "pending");
        assert.equal(value.file.hunks.length, 1);
        assert.equal(value.file.hunks[0].newStart, 2);
        assert.equal(value.file.hunks[0].newCount, 3);
        assert.equal(value.file.fileStatus, "pending");
        return value;
      },
    );
    assert.notEqual(
      trackedAfterDirtyHostWrite.file.current.digest,
      trackedAfterOpenDiffHostWrite.file.current.digest,
    );

    await writeExternalSource(folder, files.externalIgnored, "ignored update\n");
    await settleForbidden(
      folder,
      [files.externalIgnored],
      watcher,
      "ignored host-write reconciliation",
    );
    await assertNoUnknownTrackerEntries(folder);

    /*
     * Opening a saved file and saving an edited document are independent
     * lifecycle paths. The extension must initialize the eligible source and
     * must not initialize the ignored source even if both are opened and saved
     * through the same VS Code API.
     */
    const openedEligible = "opened-after-activation.txt";
    const openedIgnored = "opened-ignored.txt";
    await appendIgnoreRules(folder, [openedIgnored]);
    watcher.addPath(openedIgnored);
    await writeSource(folder, openedEligible, "opened eligible\n");
    await writeSource(folder, openedIgnored, "opened ignored\n");
    await openSource(folder, openedEligible);
    await openSource(folder, openedIgnored);
    await waitForMetadata(folder, openedEligible);
    expectedPaths.add(openedEligible);
    await settleForbidden(folder, [openedIgnored], watcher, "open");

    const eligibleDocument = await openSource(folder, openedEligible);
    const eligibleEdit = new vscode.WorkspaceEdit();
    eligibleEdit.insert(
      sourceUri(folder, openedEligible),
      eligibleDocument.lineAt(0).range.end,
      " updated",
    );
    assert.equal(await vscode.workspace.applyEdit(eligibleEdit), true);
    assert.equal(await eligibleDocument.save(), true);
    await waitForMetadata(folder, openedEligible);

    const ignoredDocument = await openSource(folder, openedIgnored);
    const ignoredEdit = new vscode.WorkspaceEdit();
    ignoredEdit.insert(
      sourceUri(folder, openedIgnored),
      ignoredDocument.lineAt(0).range.end,
      " updated",
    );
    assert.equal(await vscode.workspace.applyEdit(ignoredEdit), true);
    assert.equal(await ignoredDocument.save(), true);
    await settleForbidden(folder, [openedIgnored], watcher, "save ignored");

    /*
     * A force-added path is still ignored by Git.  This source is present in
     * the index specifically to catch implementations that use index
     * membership as an override.  Opening, saving, and invoking a file action
     * must all leave the same absence invariant intact.
     */
    const forceAddedDocument = await openSource(folder, files.forceAddedSecret);
    const forceAddedEdit = new vscode.WorkspaceEdit();
    forceAddedEdit.insert(
      sourceUri(folder, files.forceAddedSecret),
      forceAddedDocument.lineAt(0).range.end,
      " updated",
    );
    assert.equal(await vscode.workspace.applyEdit(forceAddedEdit), true);
    assert.equal(await forceAddedDocument.save(), true);
    await settleForbidden(
      folder,
      [files.forceAddedSecret],
      watcher,
      "force-added ignored save",
    );
    for (const command of [
      "codeReviewTracker.markFilePending",
      "codeReviewTracker.markFileInReview",
      "codeReviewTracker.markFileReviewed",
    ]) {
      await markFile(folder, files.forceAddedSecret, command);
      await settleForbidden(
        folder,
        [files.forceAddedSecret],
        watcher,
        `force-added ignored ${command}`,
      );
    }

    // Isolate the open-document fallback from the creation callback. The file
    // starts excluded by the root .gitignore, so its create event must not
    // write metadata. Removing that exclusion triggers the .gitignore watcher;
    // opening the file still verifies the interaction path independently.
    await writeSource(folder, files.openFallback, "open fallback\n");
    await settleForbidden(
      folder,
      [files.openFallback],
      fallbackWatcher,
      "open fallback before eligibility",
    );
    await rewriteIgnoreFile(folder, [files.openFallback]);
    fallbackWatcher.removePath(files.openFallback);
    await openSource(folder, files.openFallback);
    await waitForMetadata(folder, files.openFallback);
    expectedPaths.add(files.openFallback);

    /*
     * File-level status commands are tested on a brand-new untracked file so
     * the command itself must perform automatic initialization. Every state is
     * asserted on disk. The same commands are then sent to an ignored source;
     * their caught warning must not leave any persisted state behind.
     */
    const fileCommandEligible = "file-command-eligible.txt";
    const fileCommandIgnored = "file-command-ignored.txt";
    await appendIgnoreRules(folder, [fileCommandIgnored]);
    watcher.addPath(fileCommandIgnored);
    await writeSource(folder, fileCommandEligible, "file command\n");
    await writeSource(folder, fileCommandIgnored, "ignored command\n");
    await markFile(folder, fileCommandEligible, "codeReviewTracker.markFilePending");
    await assertStatus(folder, fileCommandEligible, "pending");
    expectedPaths.add(fileCommandEligible);
    await markFile(folder, fileCommandEligible, "codeReviewTracker.markFileInReview");
    const firstReviewerMetadata = await assertStatus(
      folder,
      fileCommandEligible,
      "inReview",
    );
    assert.equal(
      firstReviewerMetadata.file.currentLines[0].lastReviewer?.name,
      "Contract Test Reviewer",
      "the first review must use the local Git reviewer before the configured fallback",
    );
    await setGitIdentity(folder, "Changed Git Reviewer", "changed@example.test");
    await markFile(folder, fileCommandEligible, "codeReviewTracker.markFileReviewed");
    await assertStatus(folder, fileCommandEligible, "reviewed");
    for (const command of [
      "codeReviewTracker.markFilePending",
      "codeReviewTracker.markFileInReview",
      "codeReviewTracker.markFileReviewed",
    ]) {
      await markFile(folder, fileCommandIgnored, command);
      await settleForbidden(folder, [fileCommandIgnored], watcher, `ignored ${command}`);
    }

    // The file-command fallback is initially invisible to tracking because it
    // is excluded through the root .gitignore. Its first interaction must
    // still initialize it after the exclusion is removed.
    await writeSource(
      folder,
      files.fileCommandFallback,
      "file command fallback\n",
    );
    await settleForbidden(
      folder,
      [files.fileCommandFallback],
      fallbackWatcher,
      "file command fallback before eligibility",
    );
    await rewriteIgnoreFile(folder, [files.fileCommandFallback]);
    fallbackWatcher.removePath(files.fileCommandFallback);
    await markFile(
      folder,
      files.fileCommandFallback,
      "codeReviewTracker.markFilePending",
    );
    await assertStatus(folder, files.fileCommandFallback, "pending");
    expectedPaths.add(files.fileCommandFallback);
    await markFile(
      folder,
      files.fileCommandFallback,
      "codeReviewTracker.markFileInReview",
    );
    const cachedReviewerMetadata = await assertStatus(
      folder,
      files.fileCommandFallback,
      "inReview",
    );
    assert.equal(
      cachedReviewerMetadata.file.currentLines[0].lastReviewer?.name,
      "Contract Test Reviewer",
      "later reviews must reuse the cached reviewer after Git changes",
    );
    await markFile(
      folder,
      files.fileCommandFallback,
      "codeReviewTracker.markFileReviewed",
    );
    await assertStatus(folder, files.fileCommandFallback, "reviewed");
    /*
     * The active-editor commands use a different extension entry point from
     * the Explorer file commands. They must initialize and mutate eligible
     * files, while the same three commands must reject ignored files without
     * writing a record.
     */
    const lineEligible = "line-command-eligible.txt";
    const lineIgnored = "line-command-ignored.txt";
    await appendIgnoreRules(folder, [lineIgnored]);
    watcher.addPath(lineIgnored);
    await writeSource(folder, lineEligible, "line command\n");
    await writeSource(folder, lineIgnored, "ignored line command\n");
    for (const [command, expected] of [
      ["codeReviewTracker.markPending", "pending"],
      ["codeReviewTracker.markInReview", "inReview"],
      ["codeReviewTracker.markReviewed", "reviewed"],
    ]) {
      await markActive(folder, lineEligible, command);
      await assertStatus(folder, lineEligible, expected);
    }
    expectedPaths.add(lineEligible);
    for (const command of [
      "codeReviewTracker.markPending",
      "codeReviewTracker.markInReview",
      "codeReviewTracker.markReviewed",
    ]) {
      await markActive(folder, lineIgnored, command);
      await settleForbidden(folder, [lineIgnored], watcher, `ignored ${command}`);
    }

    await writeSource(
      folder,
      files.lineCommandFallback,
      "line command fallback\n",
    );
    await settleForbidden(
      folder,
      [files.lineCommandFallback],
      fallbackWatcher,
      "line command fallback before eligibility",
    );
    await rewriteIgnoreFile(folder, [files.lineCommandFallback]);
    fallbackWatcher.removePath(files.lineCommandFallback);
    for (const [command, expected] of [
      ["codeReviewTracker.markPending", "pending"],
      ["codeReviewTracker.markInReview", "inReview"],
      ["codeReviewTracker.markReviewed", "reviewed"],
    ]) {
      await markActive(folder, files.lineCommandFallback, command);
      await assertStatus(folder, files.lineCommandFallback, expected);
    }
    expectedPaths.add(files.lineCommandFallback);

    /*
     * Opening a review diff is also an interaction. The eligible diff must
     * have a baseline URI; the ignored diff must leave the tracker unchanged.
     */
    await closeAllTabs();
    await vscode.commands.executeCommand(
      "codeReviewTracker.openReviewDiff",
      sourceUri(folder, createdEligible),
    );
    await waitUntil("eligible review diff", () =>
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some(
          (tab) =>
            tab.input instanceof vscode.TabInputTextDiff &&
            tab.input.modified.toString() === sourceUri(folder, createdEligible).toString() &&
            tab.input.original.scheme === "code-review-baseline",
        ),
      ),
    );
    await vscode.commands.executeCommand(
      "codeReviewTracker.openReviewDiff",
      sourceUri(folder, fileCommandIgnored),
    );
    await settleForbidden(folder, [fileCommandIgnored], watcher, "ignored diff");

    await writeSource(folder, files.diffFallback, "diff fallback\n");
    await settleForbidden(
      folder,
      [files.diffFallback],
      fallbackWatcher,
      "diff fallback before eligibility",
    );
    await rewriteIgnoreFile(folder, [files.diffFallback]);
    fallbackWatcher.removePath(files.diffFallback);
    await vscode.commands.executeCommand(
      "codeReviewTracker.openReviewDiff",
      sourceUri(folder, files.diffFallback),
    );
    await waitForMetadata(folder, files.diffFallback);
    expectedPaths.add(files.diffFallback);
    await waitUntil("fallback review diff", () =>
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some(
          (tab) =>
            tab.input instanceof vscode.TabInputTextDiff &&
            tab.input.modified.toString() ===
              sourceUri(folder, files.diffFallback).toString() &&
            tab.input.original.scheme === "code-review-baseline",
        ),
      ),
    );

    /*
     * A folder status must recurse, initialize files that did not previously
     * have metadata, and support all three states. The mixed folder proves
     * that its ignored descendant is skipped while its eligible sibling moves
     * through the exact same transitions. The ignored-only folder proves that
     * a folder command cannot create a forbidden record as a side effect.
     */
    const mixedFolder = "mixed-folder";
    const mixedEligible = `${mixedFolder}/allowed.txt`;
    const mixedNestedEligible = `${mixedFolder}/nested/deep-allowed.txt`;
    const mixedIgnored = `${mixedFolder}/ignored.txt`;
    const outsideFolderEligible = "outside-folder-command.txt";
    const ignoredOnlyFolder = "ignored-only-folder";
    const ignoredOnly = `${ignoredOnlyFolder}/source.txt`;
    await appendIgnoreRules(folder, [mixedIgnored, `${ignoredOnlyFolder}/`]);
    watcher.addPath(mixedIgnored);
    watcher.addPath(ignoredOnly);
    await writeSource(folder, mixedEligible, "mixed eligible\n");
    await writeSource(folder, mixedNestedEligible, "mixed nested eligible\n");
    await writeSource(folder, mixedIgnored, "mixed ignored\n");
    await writeSource(folder, ignoredOnly, "ignored only\n");
    await writeSource(folder, outsideFolderEligible, "outside folder command\n");
    await waitForMetadata(folder, outsideFolderEligible);
    expectedPaths.add(outsideFolderEligible);
    const outsideFolderStatus =
      (await assertMetadataPresent(folder, outsideFolderEligible)).file.fileStatus;
    const mixedUri = sourceUri(folder, mixedFolder);
    const ignoredOnlyUri = sourceUri(folder, ignoredOnlyFolder);
    for (const [command, expected] of [
      ["codeReviewTracker.markFolderPending", "pending"],
      ["codeReviewTracker.markFolderInReview", "inReview"],
      ["codeReviewTracker.markFolderReviewed", "reviewed"],
    ]) {
      await vscode.commands.executeCommand(command, mixedUri);
      await assertStatus(folder, mixedEligible, expected);
      await assertStatus(folder, mixedNestedEligible, expected);
      await assertStatus(folder, outsideFolderEligible, outsideFolderStatus);
      await settleForbidden(folder, [mixedIgnored], watcher, `mixed ${command}`);
      await vscode.commands.executeCommand(command, ignoredOnlyUri);
      await settleForbidden(folder, [ignoredOnly], watcher, `ignored-only ${command}`);
      await assertNoExplicitTarget(
        folder,
        ignoredOnlyFolder,
        `ignored-only ${command}`,
      );
    }
    expectedPaths.add(mixedEligible);
    expectedPaths.add(mixedNestedEligible);

    // Folder interaction has its own fallback path. The child is invisible to
    // the creation watcher while the root .gitignore contains the rule; after
    // that rule is removed, the first folder command must discover and
    // initialize it.
    await writeSource(folder, files.fallbackFolderFile, "fallback folder\n");
    await settleForbidden(
      folder,
      [files.fallbackFolderFile],
      fallbackWatcher,
      "folder fallback before eligibility",
    );
    await rewriteIgnoreFile(folder, ["fallback-folder/*"]);
    fallbackWatcher.removePath(files.fallbackFolderFile);
    const fallbackFolderUri = sourceUri(folder, files.fallbackFolder);
    for (const [command, expected] of [
      ["codeReviewTracker.markFolderPending", "pending"],
      ["codeReviewTracker.markFolderInReview", "inReview"],
      ["codeReviewTracker.markFolderReviewed", "reviewed"],
    ]) {
      await vscode.commands.executeCommand(command, fallbackFolderUri);
      await assertStatus(folder, files.fallbackFolderFile, expected);
    }
    expectedPaths.add(files.fallbackFolderFile);

    /*
     * Dynamic ignore handling is a separate invariant: a file can be validly
     * tracked, then become ignored when .gitignore changes. Its metadata and
     * snapshot must be removed, and all later interactions must remain blocked.
     * Removing the rule and refreshing must make the source eligible again.
     */
    const becomesIgnored = "becomes-ignored.txt";
    const becomesIgnoredFolder = "becomes-ignored-folder";
    const becomesIgnoredChild = `${becomesIgnoredFolder}/child.txt`;
    await writeSource(folder, becomesIgnored, "becomes ignored\n");
    await writeSource(folder, becomesIgnoredChild, "becomes ignored child\n");
    await waitForMetadata(folder, becomesIgnored);
    await waitForMetadata(folder, becomesIgnoredChild);
    expectedPaths.add(becomesIgnored);
    expectedPaths.add(becomesIgnoredChild);
    const dynamicWatcher = watchForbiddenPaths(folder, [
      becomesIgnored,
      becomesIgnoredChild,
    ]);
    try {
      // Omit the explicit refresh: the .gitignore watcher itself must remove
      // existing metadata and snapshots when the rule changes.
      await appendIgnoreRules(
        folder,
        [becomesIgnored, `${becomesIgnoredFolder}/`],
        { refresh: false },
      );
      await waitForMetadataMissing(folder, becomesIgnored, { timeoutMs: 8_000 });
      await waitForMetadataMissing(folder, becomesIgnoredChild, { timeoutMs: 8_000 });
      expectedPaths.delete(becomesIgnored);
      expectedPaths.delete(becomesIgnoredChild);
      await assertAbsentDuring(folder, [becomesIgnored, becomesIgnoredChild], {
        durationMs: 1_000,
        context: "dynamic ignore cleanup",
      });
      await assertForbidden(
        folder,
        [becomesIgnored, becomesIgnoredChild],
        dynamicWatcher,
        "dynamic ignore cleanup",
      );
      for (const command of [
        "codeReviewTracker.openReviewDiff",
        "codeReviewTracker.markFilePending",
        "codeReviewTracker.markFileInReview",
        "codeReviewTracker.markFileReviewed",
      ]) {
        await vscode.commands.executeCommand(command, sourceUri(folder, becomesIgnored));
      }
      await vscode.commands.executeCommand(
        "codeReviewTracker.markFolderReviewed",
        sourceUri(folder, becomesIgnoredFolder),
      );
      const ignoredDynamicDocument = await openSource(folder, becomesIgnored);
      const ignoredDynamicEdit = new vscode.WorkspaceEdit();
      ignoredDynamicEdit.insert(
        sourceUri(folder, becomesIgnored),
        ignoredDynamicDocument.lineAt(0).range.end,
        " ignored",
      );
      assert.equal(await vscode.workspace.applyEdit(ignoredDynamicEdit), true);
      assert.equal(await ignoredDynamicDocument.save(), true);
      for (const command of [
        "codeReviewTracker.markPending",
        "codeReviewTracker.markInReview",
        "codeReviewTracker.markReviewed",
      ]) {
        await markActive(folder, becomesIgnored, command);
      }
      await vscode.commands.executeCommand("codeReviewTracker.refresh");
      await assertAbsentDuring(folder, [becomesIgnored, becomesIgnoredChild], {
        durationMs: 1_000,
        context: "commands after dynamic ignore",
      });
      dynamicWatcher.assertNoForbiddenEvents("commands after dynamic ignore");

      await replaceIgnoreRules(
        folder,
        [
          "ignored-root.txt",
          "ignored-after-activation.txt",
          "external-ignored.txt",
          "opened-ignored.txt",
          "file-command-ignored.txt",
          "line-command-ignored.txt",
          "ignored-folder/*",
          "!ignored-folder/allowed.txt",
          "*.secret",
          "!allowed.secret",
          "/root-only.txt",
          "dynamic-ignored.txt",
          "dynamic-folder/",
          "ignored-before-restart.txt",
          "ignored-only-folder/",
          "mixed-folder/ignored.txt",
        ].join("\n") + "\n",
      );
      await waitForMetadata(folder, becomesIgnored);
      await waitForMetadata(folder, becomesIgnoredChild);
      expectedPaths.add(becomesIgnored);
      expectedPaths.add(becomesIgnoredChild);
    } finally {
      dynamicWatcher.dispose();
    }

    /*
     * Workspace-wide commands must apply only to eligible files. They are
     * intentionally run after new ignored files exist so a regression in the
     * global initialization path cannot hide behind earlier per-file guards.
     */
    await vscode.commands.executeCommand("codeReviewTracker.initializePending");
    await waitForMetadata(folder, files.tracked);
    await settleForbidden(folder, alwaysForbidden.concat([
      createdIgnored,
      openedIgnored,
      fileCommandIgnored,
      lineIgnored,
      mixedIgnored,
      ignoredOnly,
    ]), watcher, "workspace pending initialization");
    await vscode.commands.executeCommand("codeReviewTracker.initializeReviewed");
    await assertStatus(folder, files.tracked, "reviewed");
    await assertMetadataPaths(folder, expectedPaths, "workspace reviewed");
    await assertEnabledInitialization(folder, "workspace reviewed");
    await settleForbidden(folder, alwaysForbidden.concat([
      createdIgnored,
      openedIgnored,
      fileCommandIgnored,
      lineIgnored,
      mixedIgnored,
      ignoredOnly,
    ]), watcher, "workspace reviewed initialization");

    /*
     * Deleting a source is persisted as hidden state during the current
     * session. The restart suite verifies that stale metadata and snapshots
     * are removed once VS Code starts again.
     */
    await vscode.workspace.fs.delete(sourceUri(folder, files.deletedBeforeRestart));
    const deletedInventory = await readInventory(folder);
    assert.equal(
      (deletedInventory.recordsByPath.get(files.deletedBeforeRestart) ?? []).length,
      1,
      "deleting a source must preserve its metadata for the current session",
    );
    await assertNoUnknownTrackerEntries(folder);
  } finally {
    watcher.assertNoForbiddenEvents("contract suite");
    watcher.dispose();
    fallbackWatcher.dispose();
  }
}

module.exports = { run };
