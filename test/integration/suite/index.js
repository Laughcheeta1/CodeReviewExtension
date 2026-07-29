const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const vscode = require("vscode");
// RevExt: 1
function metadataUri(folder, path) {
  const name = createHash("sha256").update(path).digest("hex");
  return vscode.Uri.joinPath(
    folder.uri,
    ".vscode",
    "code-review-tracker",
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
    "codeReviewTracker.markHunkPending",
    "codeReviewTracker.markHunkReviewed",
    "codeReviewTracker.initializePending",
    "codeReviewTracker.initializeReviewed",
    "codeReviewTracker.refresh",
  ])
    assert.ok(commands.has(command), `${command} is registered`);
// RevExt: 6
  const folder = vscode.workspace.workspaceFolders[0];
  assert.ok(folder, "integration workspace is available");
  assertPending(await waitForMetadata(folder, "sample.txt"));
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