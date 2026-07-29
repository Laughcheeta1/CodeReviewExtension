const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const vscode = require("vscode");
// RevExt: 1
function metadataUri(folder, path) {
  const name = createHash("sha256").update(path).digest("hex");
  return vscode.Uri.joinPath(
    folder.uri,  // RevExt: 23
    ".vscode",  // RevExt: 25
    "code-review-tracker",  // RevExt: 27
    `${name}.json`,
  );  // RevExt: 9
}  // RevExt: 13
// RevExt: 2
async function metadata(folder, path) {
  return JSON.parse(
    new TextDecoder().decode(await vscode.workspace.fs.readFile(metadataUri(folder, path))),
  );  // RevExt: 10
}  // RevExt: 14
// RevExt: 3
async function waitForMetadata(folder, path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await metadata(folder, path);
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for review metadata for ${path}`);
}  // RevExt: 15
async function assertSnapshot(folder, stored) {
  const snapshot = vscode.Uri.joinPath(
    folder.uri,  // RevExt: 24
    ".vscode",  // RevExt: 26
    "code-review-tracker",  // RevExt: 28
    "snapshots",
    stored.file.baseline.file,
  );  // RevExt: 29
  const stat = await vscode.workspace.fs.stat(snapshot);
  assert.ok((stat.type & vscode.FileType.File) !== 0);
}  // RevExt: 21
// RevExt: 4
function assertPending(file) {
  assert.equal(file.file.baseline.size, 0);
  assert.ok(file.file.currentLines.length > 0);
  assert.ok(
    file.file.currentLines.every(
      (line) => line.changeType === "added" && line.reviewStatus === "pending",
    ),
  );  // RevExt: 11
}  // RevExt: 16
function assertInReview(file) {
  assert.ok(
    file.file.currentLines.every(
      (line) => line.changeType === "added" && line.reviewStatus === "inReview",
    ),
  );
}
// RevExt: 5
async function run() {
  const extension = vscode.extensions.getExtension("local.code-review-tracker");
  assert.ok(extension, "development extension is available");
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of [
    "codeReviewTracker.openReviewDiff",
    "codeReviewTracker.markPending",
    "codeReviewTracker.markInReview",
    "codeReviewTracker.markReviewed",
    "codeReviewTracker.markFilePending",
    "codeReviewTracker.markFileInReview",
    "codeReviewTracker.markFileReviewed",
    "codeReviewTracker.markHunkPending",
    "codeReviewTracker.markHunkReviewed",
    "codeReviewTracker.sendSelectionToTerminal",
    "codeReviewTracker.setup",
    "codeReviewTracker.initializePending",
    "codeReviewTracker.initializeReviewed",
    "codeReviewTracker.refresh",
  ])
    assert.ok(commands.has(command), `${command} is registered`);
// RevExt: 6
  const folder = vscode.workspace.workspaceFolders[0];
  assert.ok(folder, "integration workspace is available");
  await vscode.commands.executeCommand("codeReviewTracker.initializePending");
  const sample = await waitForMetadata(folder, "sample.txt");
  assertPending(sample);  // RevExt: 20
  await assertSnapshot(folder, sample);
  await vscode.workspace.getConfiguration("codeReviewTracker").update(
    "reviewerName",
    "Integration Reviewer",
    vscode.ConfigurationTarget.Workspace,
  );
  await vscode.commands.executeCommand(
    "codeReviewTracker.markFileInReview",
    vscode.Uri.joinPath(folder.uri, "sample.txt"),
  );
  assertInReview(await metadata(folder, "sample.txt"));
  await vscode.commands.executeCommand(
    "codeReviewTracker.markFilePending",
    vscode.Uri.joinPath(folder.uri, "sample.txt"),
  );
  assertPending(await metadata(folder, "sample.txt"));
  await vscode.commands.executeCommand(
    "codeReviewTracker.markFileReviewed",
    vscode.Uri.joinPath(folder.uri, "sample.txt"),
  );
  const reviewed = await metadata(folder, "sample.txt");
  assert.ok(reviewed.file.baseline.size > 0);
  assert.ok(
    reviewed.file.currentLines.every((line) => line.changeType === "unchanged"),
  );
  await vscode.commands.executeCommand(
    "codeReviewTracker.markFilePending",
    vscode.Uri.joinPath(folder.uri, "sample.txt"),
  );
  assertPending(await metadata(folder, "sample.txt"));
  await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder.uri, "sample.txt"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assertPending(await metadata(folder, "sample.txt"));
// RevExt: 7
  const createdPath = "created-after-activation.txt";
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(folder.uri, createdPath),
    new TextEncoder().encode("newly created\nfile\n"),
  );  // RevExt: 12
  assertPending(await waitForMetadata(folder, createdPath));
}  // RevExt: 17
module.exports = { run };
// RevExt: 8
// RevExt: 18
// RevExt: 22
