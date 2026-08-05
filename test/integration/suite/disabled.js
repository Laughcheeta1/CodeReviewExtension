const assert = require("node:assert/strict");
const { mkdir, writeFile: writePhysicalFile } = require("node:fs/promises");
const { dirname, join } = require("node:path");
const vscode = require("vscode");
const {
  assertAbsentDuring,
  assertMetadataMissing,
  assertNoExplicitTarget,
  assertNoUnknownTrackerEntries,
  readInventory,
  watchForbiddenPaths,
} = require("./inventory");

const encoder = new TextEncoder();

function sourceUri(folder, relativePath) {
  return vscode.Uri.joinPath(folder.uri, ...relativePath.split("/"));
}

async function writeSource(folder, relativePath, content) {
  await vscode.workspace.fs.writeFile(
    sourceUri(folder, relativePath),
    encoder.encode(content),
  );
}

async function writeExternalSource(folder, relativePath, content) {
  const absolute = join(folder.uri.fsPath, ...relativePath.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writePhysicalFile(absolute, content);
}

/*
 * A disabled workspace is the explicit opt-out boundary. This suite does not
 * invoke the opt-in setup or whole-workspace initialization commands; it
 * verifies that ordinary discovery, opening, saving, diffing, file commands,
 * and folder commands cannot silently re-enable tracking.
 */
async function run() {
  const extension = vscode.extensions.getExtension("local.code-review-tracker");
  assert.ok(extension, "the development extension must be available");
  await extension.activate();
  const reviewerConfiguration = vscode.workspace.getConfiguration(
    "codeReviewTracker",
  );
  await reviewerConfiguration.update(
    "reviewerName",
    "Contract Test Reviewer",
    vscode.ConfigurationTarget.Global,
  );
  await reviewerConfiguration.update(
    "reviewerEmail",
    "contract@example.test",
    vscode.ConfigurationTarget.Global,
  );
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the disabled workspace must be available");

  const existing = [
    "tracked.txt",
    "untracked.txt",
    "nested/eligible.txt",
    "ignored-root.txt",
    "ignored-folder/hidden.txt",
    "ignored-folder/allowed.txt",
    "credentials.secret",
    "allowed.secret",
    "root-only.txt",
    "nested/root-only.txt",
    "info-excluded.txt",
    "force-added.secret",
    "dynamic-ignored.txt",
    "dynamic-folder/source.txt",
    "deleted-before-restart.txt",
    "node_modules/protected.js",
    "external-ignored.txt",
  ];
  const created = [
    "disabled-created.txt",
    "disabled-opened.txt",
    "disabled-command.txt",
    "disabled-folder/source.txt",
    "disabled-external.txt",
  ];
  const forbidden = [...existing, ...created];
  const watcher = watchForbiddenPaths(folder, forbidden);
  try {
    const startupInventory = await readInventory(folder);
    assert.deepEqual(
      startupInventory.initialization,
      { schemaVersion: 1, state: "disabled" },
      "disabled startup must preserve the explicit opt-out configuration",
    );
    for (const relativePath of existing) {
      await assertMetadataMissing(folder, relativePath, "disabled startup");
      await assertNoExplicitTarget(folder, relativePath, "disabled startup");
    }

    await writeSource(folder, created[0], "created while disabled\n");
    const opened = sourceUri(folder, created[1]);
    await writeSource(folder, created[1], "opened while disabled\n");
    await writeSource(folder, created[2], "command while disabled\n");
    await vscode.workspace.fs.createDirectory(
      sourceUri(folder, "disabled-folder"),
    );
    await writeSource(folder, created[3], "folder while disabled\n");
    await writeExternalSource(
      folder,
      created[4],
      "external create while disabled\n",
    );
    await writeExternalSource(
      folder,
      "external-ignored.txt",
      "external ignored while disabled\n",
    );
    const openedDocument = await vscode.workspace.openTextDocument(opened);
    await vscode.window.showTextDocument(openedDocument, { preview: false });
    const edit = new vscode.WorkspaceEdit();
    edit.insert(
      opened,
      openedDocument.lineAt(0).range.end,
      " updated",
    );
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await openedDocument.save(), true);

    await vscode.commands.executeCommand(
      "codeReviewTracker.openReviewDiff",
      opened,
    );
    for (const command of [
      "codeReviewTracker.markFilePending",
      "codeReviewTracker.markFileInReview",
      "codeReviewTracker.markFileReviewed",
    ]) {
      await vscode.commands.executeCommand(
        command,
        sourceUri(folder, created[2]),
      );
    }
    const activeDocument = await vscode.workspace.openTextDocument(
      sourceUri(folder, created[2]),
    );
    await vscode.window.showTextDocument(activeDocument, { preview: false });
    for (const command of [
      "codeReviewTracker.markPending",
      "codeReviewTracker.markInReview",
      "codeReviewTracker.markReviewed",
    ]) {
      await vscode.commands.executeCommand(command);
    }
    for (const command of [
      "codeReviewTracker.markFolderPending",
      "codeReviewTracker.markFolderInReview",
      "codeReviewTracker.markFolderReviewed",
    ]) {
      await vscode.commands.executeCommand(
        command,
        sourceUri(folder, "disabled-folder"),
      );
    }
    await vscode.commands.executeCommand("codeReviewTracker.refresh");

    await assertAbsentDuring(folder, forbidden, {
      durationMs: 1_000,
      context: "disabled workspace",
    });
    for (const relativePath of forbidden) {
      await assertNoExplicitTarget(folder, relativePath, "disabled workspace");
    }
    watcher.assertNoForbiddenEvents("disabled workspace");
    const inventory = await readInventory(folder);
    assert.deepEqual(
      inventory.initialization,
      { schemaVersion: 1, state: "disabled" },
      "disabled interactions must never re-enable tracking",
    );
    await assertNoUnknownTrackerEntries(folder, "disabled workspace");
    assert.equal(
      inventory.recordsByPath.size,
      0,
      "disabled workspaces must not persist any source metadata",
    );
  } finally {
    watcher.dispose();
  }
}

module.exports = { run };
