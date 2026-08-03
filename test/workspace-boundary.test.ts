import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { GitService } from "../src/git.ts";

const execute = promisify(execFile);

/*
 * This is the only unit-level test in the replacement suite. It verifies the
 * one Git responsibility permitted by the workspace contract: evaluating
 * ignore rules. The Extension Host tests remain authoritative for metadata
 * creation; this test exists to ensure the ignore oracle itself handles the
 * cases that would otherwise make those integration assertions unsound.
 *
 * The fixture deliberately combines exact rules, nested rules with a
 * negation, a glob with a negation, an anchored root rule, a filename with a
 * space, and a force-added ignored file. It also supplies 501 matching paths
 * so the production batching boundary (500 paths per check-ignore invocation)
 * is exercised rather than merely testing the first batch. The index snapshot
 * around the call proves that checking ignore status is read-only. Finally, a
 * separate non-Git directory verifies the documented fallback: without a Git
 * worktree there are no Git ignore decisions, so ordinary files remain
 * eligible instead of being silently dropped.
 */
test("Git ignore evaluation is index-independent and honors nested rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-review-tracker-boundary-"));
  try {
    await execute("git", ["init", "--quiet", directory]);
    await mkdir(join(directory, "ignored-folder"), { recursive: true });
    await writeFile(
      join(directory, ".gitignore"),
      [
        "ignored-root.txt",
        "ignored-folder/*",
        "!ignored-folder/allowed.txt",
        "*.secret",
        "!allowed.secret",
        "/root-only.txt",
        "space ignored.txt",
        "batch-ignored/*",
      ].join("\n") + "\n",
    );
    const files = [
      "ignored-root.txt",
      "ignored-folder/hidden.txt",
      "ignored-folder/allowed.txt",
      "credentials.secret",
      "allowed.secret",
      "root-only.txt",
      "nested/root-only.txt",
      "ordinary.txt",
      "force-added.secret",
      "space ignored.txt",
    ];
    for (const relativePath of files) {
      const absolute = join(directory, ...relativePath.split("/"));
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, `${relativePath}\n`);
    }
    const batchPaths = Array.from(
      { length: 501 },
      (_, index) => `batch-ignored/file-${String(index).padStart(3, "0")}.txt`,
    );
    for (const relativePath of batchPaths) {
      const absolute = join(directory, ...relativePath.split("/"));
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, `${relativePath}\n`);
    }
    await execute("git", ["-C", directory, "add", "-f", "force-added.secret"]);

    const beforeIndex = (
      await execute("git", ["-C", directory, "ls-files", "--stage", "-z"])
    ).stdout;
    const ignored = await new GitService().ignoredPaths(
      directory,
      [...files, ...batchPaths],
    );
    const afterIndex = (
      await execute("git", ["-C", directory, "ls-files", "--stage", "-z"])
    ).stdout;
    assert.equal(
      afterIndex,
      beforeIndex,
      "ignore evaluation must not mutate the Git index",
    );
    assert.deepEqual([...ignored].sort(), [
      ...batchPaths,
      "credentials.secret",
      "force-added.secret",
      "ignored-folder/hidden.txt",
      "ignored-root.txt",
      "root-only.txt",
      "space ignored.txt",
    ]);
    assert.equal(ignored.has("ignored-folder/allowed.txt"), false);
    assert.equal(ignored.has("allowed.secret"), false);
    assert.equal(ignored.has("nested/root-only.txt"), false);
    assert.equal(ignored.has("ordinary.txt"), false);

    const outsideGit = await mkdtemp(
      join(tmpdir(), "code-review-tracker-no-git-"),
    );
    try {
      await writeFile(join(outsideGit, "ordinary.txt"), "ordinary\n");
      assert.deepEqual(
        [...await new GitService().ignoredPaths(outsideGit, ["ordinary.txt"])],
        [],
        "a non-Git workspace must not make files ineligible",
      );
    } finally {
      await rm(outsideGit, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/*
 * A failed ignore lookup is not equivalent to “no ignored files.”  That
 * distinction is the safety boundary for every automatic metadata writer:
 * returning an empty set here would make a Git workspace track an ignored
 * source whenever the Git executable is missing, temporarily broken, or
 * unavailable in the VS Code extension host's PATH.  The production service
 * therefore rejects the lookup for a real worktree, while retaining the
 * documented empty result for a directory that is genuinely outside Git.
 */
test("Git ignore lookup fails closed when a worktree cannot run Git", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-review-tracker-ignore-failure-"));
  try {
    await execute("git", ["init", "--quiet", directory]);
    await writeFile(join(directory, ".gitignore"), "secret.txt\n");
    await writeFile(join(directory, "secret.txt"), "secret\n");

    await assert.rejects(
      new GitService("code-review-tracker-git-that-does-not-exist").ignoredPaths(
        directory,
        ["secret.txt", "ordinary.txt"],
      ),
      /Unable to evaluate \.gitignore rules/,
      "a Git worktree must not treat an unavailable ignore check as an empty set",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
