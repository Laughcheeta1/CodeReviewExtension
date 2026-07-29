import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTests } from "@vscode/test-electron";
const extensionDevelopmentPath = path.resolve(import.meta.dirname, "../..");
const extensionTestsPath = path.resolve(import.meta.dirname, "suite/index.js");
const startupCleanupTestsPath = path.resolve(
  import.meta.dirname,
  "suite/startup-cleanup.js",
);
const workspace = await mkdtemp(
  path.join(tmpdir(), "code-review-tracker-integration-"),
);  // RevExt: 1
const userData = await mkdtemp(
  path.join(tmpdir(), "code-review-tracker-user-data-"),
);  // RevExt: 2
try {
  await writeFile(path.join(workspace, "sample.txt"), "saved content\n");
  await mkdir(path.join(workspace, ".vscode", "code-review-tracker"), {
    recursive: true,
  });  // RevExt: 3
  await writeFile(
    path.join(workspace, ".vscode", "code-review-tracker", "initialization.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      state: "disabled",
    })}\n`,
  );
  await runTests({
    version: "1.127.0",
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      "--disable-extensions",
      "--disable-workspace-trust",
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${userData}`,
      workspace,
    ],
  });  // RevExt: 4
  await runTests({
    version: "1.127.0",
    extensionDevelopmentPath,
    extensionTestsPath: startupCleanupTestsPath,
    launchArgs: [
      "--disable-extensions",
      "--disable-workspace-trust",
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${userData}`,
      workspace,
    ],
  });
} finally {
  await Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(userData, { recursive: true, force: true }),
  ]);
}
