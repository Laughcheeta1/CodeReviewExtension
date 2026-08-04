const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { mkdir, writeFile: writePhysicalFile } = require("node:fs/promises");
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

async function markActive(folder, relativePath, command) {
  const document = await openSource(folder, relativePath);
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor, "an editor must be active for line-level commands");
  assert.equal(editor.document.uri.toString(), document.uri.toString());
  editor.selection = new vscode.Selection(0, 0, 0, 0);
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
    legacyJsx: "legacy-component.tsx",
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
    files.legacyJsx,
    files.untracked,
    files.nested,
    files.nestedIgnore,
    files.nestedAllowed,
    files.infoExcluded,
    files.ignoredAllowed,
    files.allowedSecret,
    files.nestedRootOnly,
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
      files.deletedBeforeRestart,
    ]) {
      await waitForMetadata(folder, relativePath, { timeoutMs: 8_000 });
    }
    await assertMetadataPaths(folder, expectedPaths, "startup");
    await assertEnabledInitialization(folder, "startup");
    await settleForbidden(folder, alwaysForbidden, watcher, "startup");
    await assertNoReservedRecords(folder);

    /*
     * Legacy JSX migration must rewrite only the generated JSX line comment.
     * The command must also preserve existing review decisions and advance the
     * per-file marker sequence beyond the migrated identity.
     */
    const legacyBefore = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(sourceUri(folder, files.legacyJsx)),
    );
    assert.match(legacyBefore, /<span \/>\s{2}\/\/ RevExt: 7/);
    await markFile(
      folder,
      files.legacyJsx,
      "codeReviewTracker.markFileInReview",
    );
    const beforeMigration = await assertStatus(
      folder,
      files.legacyJsx,
      "inReview",
    );
    await vscode.commands.executeCommand("codeReviewTracker.migrateJsxMarkers");
    const legacyAfter = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(sourceUri(folder, files.legacyJsx)),
    );
    assert.doesNotMatch(legacyAfter, /<span \/>\s{2}\/\/ RevExt:/);
    assert.match(legacyAfter, /<span \/>\s{2}\{\/\* RevExt: 7 \*\/\}/);
    const afterMigration = await assertStatus(
      folder,
      files.legacyJsx,
      "inReview",
    );
    assert.notEqual(
      beforeMigration.file.current.digest,
      afterMigration.file.current.digest,
      "migrating marker syntax must update the persisted current digest",
    );
    assert.equal(
      afterMigration.file.nextRevExtId >= 8,
      true,
      "migrating an existing marker must preserve the next-id sequence",
    );
    assert.equal(
      afterMigration.file.currentLines
        .filter((line) => line.changeType === "added")
        .every((line) => line.reviewStatus === "inReview"),
      true,
      "migrating marker syntax must preserve line review decisions",
    );
    await markFile(
      folder,
      files.legacyJsx,
      "codeReviewTracker.markFileReviewed",
    );
    const promotedLegacy = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(sourceUri(folder, files.legacyJsx)),
    );
    assert.doesNotMatch(
      promotedLegacy,
      /RevExt:/,
      "promotion must remove migrated JSX markers",
    );
    await markFile(
      folder,
      files.legacyJsx,
      "codeReviewTracker.markFilePending",
    );
    const newlyAnnotatedJsx = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(sourceUri(folder, files.legacyJsx)),
    );
    assert.doesNotMatch(newlyAnnotatedJsx, /<span \/>\s{2}\/\/ RevExt:/);
    assert.match(newlyAnnotatedJsx, /<span \/>\s{2}\{\/\* RevExt:/);
    await assertStatus(folder, files.legacyJsx, "pending");

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
