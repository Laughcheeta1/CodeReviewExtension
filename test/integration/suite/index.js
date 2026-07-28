const assert = require("node:assert/strict");
const vscode = require("vscode");
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
}
module.exports = { run };
