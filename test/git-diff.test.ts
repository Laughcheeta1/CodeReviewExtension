import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { GitService } from "../src/git.ts";

const execute = promisify(execFile);
const encoder = new TextEncoder();

async function withoutGlobalGitConfig(
  operation: () => Promise<void>,
): Promise<void> {
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const sandbox = await mkdtemp(join(tmpdir(), "code-review-tracker-home-"));
  process.env.HOME = sandbox;
  process.env.XDG_CONFIG_HOME = sandbox;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    await operation();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdg;
    }
    if (previousNoSystem === undefined) {
      delete process.env.GIT_CONFIG_NOSYSTEM;
    } else {
      process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    }
    await rm(sandbox, { recursive: true, force: true });
  }
}

test("diff returns no hunks for identical content", async () => {
  assert.deepEqual(
    await new GitService().diff(encoder.encode("a\n"), encoder.encode("a\n")),
    [],
  );
});

test("diff reports a full-addition hunk for an empty baseline", async () => {
  assert.deepEqual(
    await new GitService().diff(new Uint8Array(), encoder.encode("a\nb\n")),
    [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }],
  );
});

test("diff reports changed ranges with zero context", async () => {
  assert.deepEqual(
    await new GitService().diff(
      encoder.encode("a\nb\nc\n"),
      encoder.encode("a\nx\nc\n"),
    ),
    [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }],
  );
});

test("diff surfaces Git failures instead of returning hunks", async () => {
  await assert.rejects(
    new GitService("git-executable-that-does-not-exist").diff(
      encoder.encode("a\n"),
      encoder.encode("b\n"),
    ),
    /Git diff failed/,
  );
});

test("reviewer is undefined without a directory or an identity", async () => {
  assert.equal(await new GitService().reviewer(undefined), undefined);
  await withoutGlobalGitConfig(async () => {
    const directory = await mkdtemp(join(tmpdir(), "code-review-tracker-id-"));
    try {
      await execute("git", ["init", "--quiet", directory]);
      assert.equal(await new GitService().reviewer(directory), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
