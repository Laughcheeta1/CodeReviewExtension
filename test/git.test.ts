import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { GitService } from "../src/git.ts";

const execute = promisify(execFile);

async function temporaryRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "code-review-tracker-git-"));
  await execute("git", ["init", "--quiet", directory]);
  return directory;
}

test("reviewer reads the local Git identity", async () => {
  const directory = await temporaryRepository();
  try {
    await execute("git", ["-C", directory, "config", "user.name", "Local Reviewer"]);
    await execute(
      "git",
      ["-C", directory, "config", "user.email", "local@example.test"],
    );

    assert.deepEqual(await new GitService().reviewer(directory), {
      name: "Local Reviewer",
      email: "local@example.test",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reviewer keeps a local Git name when email is unavailable", async () => {
  const directory = await temporaryRepository();
  try {
    await execute("git", ["-C", directory, "config", "user.name", "Name Only"]);
    await execute("git", ["-C", directory, "config", "user.email", ""]);

    assert.deepEqual(await new GitService().reviewer(directory), {
      name: "Name Only",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
