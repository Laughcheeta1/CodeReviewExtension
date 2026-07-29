const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const vscode = require("vscode");

function metadataUri(folder, path) {
  return vscode.Uri.joinPath(
    folder.uri,
    ".vscode",
    "code-review-tracker",
    `${createHash("sha256").update(path).digest("hex")}.json`,
  );
}

async function run() {
  const extension = vscode.extensions.getExtension("local.code-review-tracker");
  assert.ok(extension, "development extension is available");
  await extension.activate();
  const folder = vscode.workspace.workspaceFolders[0];
  assert.ok(folder, "integration workspace is available");
  await assert.rejects(
    vscode.workspace.fs.readFile(metadataUri(folder, "sample.txt")),
    (error) => error instanceof vscode.FileSystemError && error.code === "FileNotFound",
  );
}

module.exports = { run };
