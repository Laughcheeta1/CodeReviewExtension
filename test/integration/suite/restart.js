const assert = require("node:assert/strict");
const vscode = require("vscode");
const {
  assertAbsentDuring,
  assertMetadataMissing,
  assertMetadataPresent,
  assertMetadataPaths,
  assertNoExplicitTarget,
  assertNoUnknownTrackerEntries,
  pathHash,
  readInventory,
  waitForMetadata,
  watchForbiddenPaths,
} = require("./inventory");

/*
 * This suite runs in a new VS Code process against the workspace produced by
 * contract.js. It proves that startup is a real reconciliation pass rather
 * than a one-time in-memory side effect: a file created while VS Code was
 * closed is initialized, a file deleted in the previous session is removed,
 * and an ignored file created while VS Code was closed never appears.
 */
async function run() {
  const extension = vscode.extensions.getExtension("local.code-review-tracker");
  assert.ok(extension, "the development extension must be available");
  await extension.activate();
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the integration workspace must be available");

  const forbidden = [
    "ignored-root.txt",
    "ignored-before-restart.txt",
    "ignored-folder/hidden.txt",
    "credentials.secret",
    "force-added.secret",
    "info-excluded.txt",
    "external-ignored.txt",
    "dynamic-ignored.txt",
    "dynamic-folder/source.txt",
    "ignored-after-activation.txt",
    "becomes-ignored.txt",
    "becomes-ignored-folder/child.txt",
  ];
  const watcher = watchForbiddenPaths(folder, forbidden);
  try {
    await waitForMetadata(folder, "discovered-before-restart.txt", {
      timeoutMs: 8_000,
    });
    await assertMetadataMissing(folder, "deleted-before-restart.txt");
    await assertMetadataMissing(folder, "ignored-before-restart.txt");
    await assertAbsentDuring(folder, forbidden, {
      durationMs: 1_000,
      context: "restart ignored-file invariant",
    });
    for (const relativePath of forbidden) {
      await assertNoExplicitTarget(folder, relativePath, "restart");
    }
    watcher.assertNoForbiddenEvents("restart");

    const inventory = await readInventory(folder);
    assert.equal(
      inventory.initialization?.state,
      "initialized",
      "restart must preserve the enabled workspace configuration",
    );
    assert.ok(
      inventory.initialization.targets?.some(
        (target) => target.kind === "folder" && target.path === "",
      ),
      "restart must preserve the configured workspace target",
    );
    assert.equal(
      inventory.recordsByPath.has("deleted-before-restart.txt"),
      false,
      "startup cleanup must remove metadata for a deleted source",
    );
    assert.equal(
      [...inventory.snapshotNames].some((name) =>
        name.startsWith(`${pathHash("deleted-before-restart.txt")}.`),
      ),
      false,
      "startup cleanup must remove the deleted source snapshot",
    );
    assert.equal(
      inventory.recordsByPath.has("becomes-ignored.txt"),
      false,
      "startup cleanup must remove metadata for an existing source that became ignored while closed",
    );
    assert.equal(
      [...inventory.snapshotNames].some((name) =>
        name.startsWith(`${pathHash("becomes-ignored.txt")}.`),
      ),
      false,
      "startup cleanup must remove the snapshot for an existing source that became ignored while closed",
    );
    assert.equal(
      inventory.recordsByPath.has("becomes-ignored-folder/child.txt"),
      false,
      "startup cleanup must remove metadata for an existing nested source that became ignored while closed",
    );
    assert.equal(
      [...inventory.snapshotNames].some((name) =>
        name.startsWith(`${pathHash("becomes-ignored-folder/child.txt")}.`),
      ),
      false,
      "startup cleanup must remove the nested source snapshot after it becomes ignored while closed",
    );
    await assertMetadataPresent(folder, "discovered-before-restart.txt");
    await assertMetadataPaths(folder, [
      ".gitignore",
      "tracked.txt",
      "untracked.txt",
      "nested/eligible.txt",
      "ignored-folder/allowed.txt",
      "allowed.secret",
      "nested/root-only.txt",
      "created-after-activation.txt",
      "created-by-host-filesystem.txt",
      "opened-after-activation.txt",
      "open-fallback.txt",
      "diff-fallback.txt",
      "file-command-eligible.txt",
      "file-command-fallback.txt",
      "line-command-eligible.txt",
      "line-command-fallback.txt",
      "mixed-folder/allowed.txt",
      "mixed-folder/nested/deep-allowed.txt",
      "outside-folder-command.txt",
      "fallback-folder/source.txt",
      "discovered-before-restart.txt",
    ], "restart");
    await assertNoUnknownTrackerEntries(folder);

    /*
     * Restart must preserve the same Git boundary as the first activation:
     * an untracked file is initialized, and the force-added ignored file is
     * still absent. This second assertion catches implementations that only
     * apply ignore filtering during live events.
     */
    await vscode.commands.executeCommand("codeReviewTracker.refresh");
    await waitForMetadata(folder, "discovered-before-restart.txt");
    await assertAbsentDuring(folder, forbidden, {
      durationMs: 750,
      context: "restart refresh",
    });
    watcher.assertNoForbiddenEvents("restart refresh");
  } finally {
    watcher.dispose();
  }
}

module.exports = { run };
