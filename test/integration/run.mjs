import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runTests } from "@vscode/test-electron";

const execute = promisify(execFile);
const extensionDevelopmentPath = path.resolve(import.meta.dirname, "../..");
const vscodeVersion = "1.127.0";

/**
 * The parent process owns fixture creation and Git-index snapshots. The
 * extension-host suites own VS Code operations and persisted-state assertions.
 * Keeping those responsibilities separate prevents a test helper inside the
 * extension host from accidentally hiding a Git-index mutation.
 */
async function git(directory, args) {
  return execute("git", ["-C", directory, ...args]);
}

async function gitIndex(directory) {
  // Names/statuses alone do not prove index immutability: a staged blob could
  // be rewritten while its path remains unchanged. The stage listing also
  // contains mode, object id, stage, and path, so it is an exact snapshot.
  const result = await git(directory, ["ls-files", "--stage", "-z"]);
  return result.stdout;
}

async function launch(workspace, userData, suite) {
  await runTests({
    version: vscodeVersion,
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(import.meta.dirname, "suite", suite),
    launchArgs: [
      "--disable-extensions",
      "--disable-workspace-trust",
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${userData}`,
      workspace,
    ],
  });
}

/**
 * Watch the tracker directory before the extension starts. A final absence
 * check alone is insufficient: a buggy lifecycle path could create metadata
 * for an ignored source and delete it later. The watcher records both the
 * final hash and its temporary-write prefix so that transient writes fail the
 * parent test as well.
 */
function watchForbiddenWrites(trackerDirectory, snapshotsDirectory, paths) {
  const hashes = new Map(
    paths.map((sourcePath) => [
      sha256(sourcePath),
      sourcePath,
    ]),
  );
  const events = [];
  const inspect = (directory, filename) => {
    if (filename === null || filename === undefined) {
      return;
    }
    const name = filename.toString();
    for (const [hash, sourcePath] of hashes) {
      if (
        name === `${hash}.json` ||
        name === `.${hash}.json` ||
        name.startsWith(`.${hash}.json.tmp-`) ||
        name.startsWith(`${hash}.`)
      ) {
        events.push({ directory, name, sourcePath });
      }
    }
  };
  const metadataWatcher = watch(trackerDirectory, (_event, filename) =>
    inspect("metadata", filename),
  );
  const snapshotWatcher = watch(snapshotsDirectory, (_event, filename) =>
    inspect("snapshot", filename),
  );
  // A tracker reset can replace the watched directory while the extension is
  // reconciling.  The final inventory and extension-host watcher remain the
  // authoritative assertions; an OS watcher error must not abort cleanup and
  // hide those results.
  metadataWatcher.on("error", () => {});
  snapshotWatcher.on("error", () => {});
  return {
    close() {
      metadataWatcher.close();
      snapshotWatcher.close();
    },
    events,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createWorkspace({ initialized }) {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "code-review-tracker-contract-")
  );
  const userData = await mkdtemp(
    path.join(tmpdir(), "code-review-tracker-contract-user-data-")
  );
  const tracker = path.join(workspace, ".vscode", "code-review-tracker");
  const snapshots = path.join(tracker, "snapshots");
  try {
    await git(workspace, ["init", "--quiet"]);
  } catch {
    // `git init` cannot run before the directory exists on some platforms.
    await execute("git", ["init", "--quiet", workspace]);
  }
  await git(workspace, ["config", "user.name", "Contract Test Reviewer"]);
  await git(workspace, ["config", "user.email", "contract@example.test"]);
  await mkdir(snapshots, { recursive: true });

  await writeFile(
    path.join(workspace, ".gitignore"),
    [
      "ignored-root.txt",
      "ignored-after-activation.txt",
      "ignored-before-restart.txt",
      "ignored-folder/*",
      "!ignored-folder/allowed.txt",
      "*.secret",
      "!allowed.secret",
      "/root-only.txt",
      "dynamic-ignored.txt",
      "dynamic-folder/",
      "external-ignored.txt",
      "",
    ].join("\n"),
  );
  await mkdir(path.join(workspace, "ignored-folder"), { recursive: true });
  await mkdir(path.join(workspace, "nested"), { recursive: true });
  await mkdir(path.join(workspace, "dynamic-folder"), { recursive: true });
  await mkdir(path.join(workspace, "node_modules"), { recursive: true });
  await mkdir(path.join(workspace, ".git", "info"), { recursive: true });
  await writeFile(
    path.join(workspace, ".git", "info", "exclude"),
    [
      "info-excluded.txt",
      "open-fallback.txt",
      "file-command-fallback.txt",
      "line-command-fallback.txt",
      "diff-fallback.txt",
      "fallback-folder/*",
      "",
    ].join("\n"),
  );

  const files = {
    tracked: "tracked.txt",
    untracked: "untracked.txt",
    nested: "nested/eligible.txt",
    ignoredRoot: "ignored-root.txt",
    ignoredAfterActivation: "ignored-after-activation.txt",
    ignoredBeforeRestart: "ignored-before-restart.txt",
    ignoredNested: "ignored-folder/hidden.txt",
    ignoredAllowed: "ignored-folder/allowed.txt",
    secret: "credentials.secret",
    allowedSecret: "allowed.secret",
    rootOnly: "root-only.txt",
    nestedRootOnly: "nested/root-only.txt",
    infoExcluded: "info-excluded.txt",
    forceAddedSecret: "force-added.secret",
    externalIgnored: "external-ignored.txt",
    dynamicIgnored: "dynamic-ignored.txt",
    dynamicFolderFile: "dynamic-folder/source.txt",
    deletedBeforeRestart: "deleted-before-restart.txt",
    protectedDependency: "node_modules/protected.js",
  };
  const contents = new Map([
    [files.tracked, "tracked\n"],
    [files.untracked, "untracked\n"],
    [files.nested, "nested eligible\n"],
    [files.ignoredRoot, "ignored root\n"],
    [files.ignoredNested, "ignored nested\n"],
    [files.ignoredAllowed, "explicitly allowed\n"],
    [files.secret, "secret\n"],
    [files.allowedSecret, "allowed secret\n"],
    [files.rootOnly, "root only\n"],
    [files.nestedRootOnly, "nested root only\n"],
    [files.infoExcluded, "info excluded\n"],
    [files.forceAddedSecret, "force added secret\n"],
    [files.dynamicIgnored, "dynamic ignored\n"],
    [files.dynamicFolderFile, "dynamic folder\n"],
    [files.deletedBeforeRestart, "deleted before restart\n"],
    [files.protectedDependency, "protected dependency\n"],
  ]);
  for (const [relativePath, content] of contents) {
    const absolute = path.join(workspace, ...relativePath.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }

  // Only these two files are staged. All other nonignored files are intentionally
  // untracked so the extension is forced to prove that the Git index is not its
  // source-discovery mechanism. The ignored secret is force-added to prove that
  // an index entry cannot override an ignore rule.
  await git(workspace, ["add", ".gitignore", files.tracked]);
  await git(workspace, ["add", "-f", files.forceAddedSecret]);
  const initialization = initialized
    ? {
        schemaVersion: 1,
        state: "initialized",
        targets: [{ kind: "folder", path: "" }],
      }
    : {
        schemaVersion: 1,
        state: "disabled",
      };
  await writeFile(
    path.join(tracker, "initialization.json"),
    `${JSON.stringify(initialization, null, 2)}\n`,
  );
  return {
    workspace,
    userData,
    tracker,
    snapshots,
    files,
    forbidden: [
      files.ignoredRoot,
      files.ignoredAfterActivation,
      files.ignoredBeforeRestart,
      files.ignoredNested,
      files.secret,
      files.forceAddedSecret,
      files.infoExcluded,
      files.externalIgnored,
      files.dynamicIgnored,
      files.dynamicFolderFile,
      files.protectedDependency,
    ],
  };
}

async function main() {
  const enabled = await createWorkspace({ initialized: true });
  const enabledIndexBefore = await gitIndex(enabled.workspace);
  const enabledWatch = watchForbiddenWrites(
    enabled.tracker,
    enabled.snapshots,
    enabled.forbidden,
  );
  let enabledFailure;
  try {
    await launch(enabled.workspace, enabled.userData, "contract.js");
    const afterFirstRun = await gitIndex(enabled.workspace);
    if (afterFirstRun !== enabledIndexBefore) {
      throw new Error(
        `The extension changed the Git index during the enabled run.\nBefore:\n${enabledIndexBefore}\nAfter:\n${afterFirstRun}`,
      );
    }
    await writeFile(
      path.join(enabled.workspace, enabled.files.ignoredBeforeRestart),
      "ignored before restart\n",
    );
    // This pair already had valid metadata at the end of the first session.
    // Making it ignored while VS Code is closed proves that activation cleanup
    // removes both the stale record and its baseline before any new lifecycle
    // event can reintroduce it.
    await appendFile(
      path.join(enabled.workspace, ".gitignore"),
      "becomes-ignored.txt\nbecomes-ignored-folder/\n",
    );
    await writeFile(
      path.join(enabled.workspace, "discovered-before-restart.txt"),
      "created while VS Code was closed\n",
    );
    await launch(enabled.workspace, enabled.userData, "restart.js");
    const afterRestart = await gitIndex(enabled.workspace);
    if (afterRestart !== enabledIndexBefore) {
      throw new Error(
        `The extension changed the Git index during restart.\nBefore:\n${enabledIndexBefore}\nAfter:\n${afterRestart}`,
      );
    }
  } catch (error) {
    enabledFailure = error;
  } finally {
    enabledWatch.close();
    await Promise.all([
      rm(enabled.workspace, { recursive: true, force: true }),
      rm(enabled.userData, { recursive: true, force: true }),
    ]);
  }
  if (enabledFailure !== undefined) {
    throw enabledFailure;
  }
  if (enabledWatch.events.length > 0) {
    throw new Error(
      `Forbidden metadata/snapshot writes were observed:\n${JSON.stringify(enabledWatch.events, null, 2)}`,
    );
  }

  const disabled = await createWorkspace({ initialized: false });
  const disabledIndexBefore = await gitIndex(disabled.workspace);
  const disabledWatch = watchForbiddenWrites(
    disabled.tracker,
    disabled.snapshots,
    [
      ...disabled.forbidden,
      "disabled-created.txt",
      "disabled-opened.txt",
      "disabled-command.txt",
      "disabled-folder/source.txt",
      "disabled-external.txt",
    ],
  );
  let disabledFailure;
  try {
    await launch(disabled.workspace, disabled.userData, "disabled.js");
    const disabledIndexAfter = await gitIndex(disabled.workspace);
    if (disabledIndexAfter !== disabledIndexBefore) {
      throw new Error("The disabled workspace changed the Git index.");
    }
  } catch (error) {
    disabledFailure = error;
  } finally {
    disabledWatch.close();
    await Promise.all([
      rm(disabled.workspace, { recursive: true, force: true }),
      rm(disabled.userData, { recursive: true, force: true }),
    ]);
  }
  if (disabledFailure !== undefined) {
    throw disabledFailure;
  }
  if (disabledWatch.events.length > 0) {
    throw new Error(
      `Disabled workspace wrote forbidden metadata/snapshots:\n${JSON.stringify(disabledWatch.events, null, 2)}`,
    );
  }
}

await main();
