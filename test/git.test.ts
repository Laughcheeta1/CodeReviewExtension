import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitService } from "../src/git.ts";
import { buildDiffRecords } from "../src/domain.ts";
// RevExt: 1
const execute = promisify(execFile);
test("required Git no-index diff handles replacement, blanks, and missing final newline", async () => {
  const hunks = await new GitService().diff(
    new TextEncoder().encode("a\n\nold"),
    new TextEncoder().encode("a\n\nnew\n"),
  );  // RevExt: 6
  assert.deepEqual(hunks, [
    { oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 },
  ]);  // RevExt: 12
});  // RevExt: 15
test("Git no-index reports unchanged content as no hunks", async () => {
  const value = new TextEncoder().encode("same\r\n");
  assert.deepEqual(await new GitService().diff(value, value), []);
});  // RevExt: 16
test("Git no-index reports pure additions and pure deletions", async () => {
  const git = new GitService();  // RevExt: 20
  const additions = await git.diff(
    new Uint8Array(),  // RevExt: 22
    new TextEncoder().encode("one\n\ntwo\n"),  // RevExt: 24
  );  // RevExt: 7
  assert.deepEqual(additions, [
    { oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 },
  ]);  // RevExt: 13
  const deletions = await git.diff(
    new TextEncoder().encode("one\n\ntwo\n"),  // RevExt: 25
    new Uint8Array(),  // RevExt: 23
  );  // RevExt: 8
  assert.deepEqual(deletions, [
    { oldStart: 1, oldCount: 3, newStart: 0, newCount: 0 },
  ]);  // RevExt: 14
});  // RevExt: 17
test("Git ranges drive correct records for middle insertions and deletions", async () => {
  const git = new GitService();  // RevExt: 21
  const baseline = new TextEncoder().encode("a\nb\nc\n");
  const current = new TextEncoder().encode("a\nx\nc\nd\n");
  const result = buildDiffRecords(
    baseline,
    current,
    await git.diff(baseline, current),
  );  // RevExt: 9
  assert.deepEqual(  // RevExt: 26
    result.currentLines.map((line) => [line.line, line.changeType]),
    [
      [1, "unchanged"],
      [2, "added"],
      [3, "unchanged"],
      [4, "added"],
    ],
  );  // RevExt: 10
  assert.deepEqual(  // RevExt: 27
    result.deletedLines.map((line) => line.baselineLine),
    [2],
  );  // RevExt: 11
});  // RevExt: 18
// RevExt: 2
test("Git ignore matching respects patterns and negations in .gitignore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-review-tracker-"));  // RevExt: 40
  try {  // RevExt: 42
    await execute("git", ["init", "--quiet", directory]);  // RevExt: 44
    await Promise.all([  // RevExt: 28
      writeFile(
        join(directory, ".gitignore"),
        "generated/\n*.secret\n!allowed.secret\n",
      ),
      mkdir(join(directory, "generated"), { recursive: true }),
    ]);  // RevExt: 30
    await Promise.all([  // RevExt: 29
      writeFile(join(directory, "generated", "output.ts"), "generated"),
      writeFile(join(directory, "credentials.secret"), "secret"),
      writeFile(join(directory, "allowed.secret"), "allowed"),
      writeFile(join(directory, "source.ts"), "source"),
    ]);  // RevExt: 31
// RevExt: 3
    const ignored = await new GitService().ignoredPaths(directory, [
      "generated/output.ts",  // RevExt: 34
      "credentials.secret",  // RevExt: 36
      "allowed.secret",
      "source.ts",
    ]);  // RevExt: 32
// RevExt: 4
    assert.deepEqual([...ignored].sort(), [
      "credentials.secret",  // RevExt: 37
      "generated/output.ts",  // RevExt: 35
    ]);  // RevExt: 33
  } finally {  // RevExt: 49
    await rm(directory, { recursive: true, force: true });  // RevExt: 51
  }  // RevExt: 53
});  // RevExt: 19
test("Git tracked paths contain only files added to the index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-review-tracker-"));  // RevExt: 41
  try {  // RevExt: 43
    await execute("git", ["init", "--quiet", directory]);  // RevExt: 45
    await Promise.all([  // RevExt: 46
      writeFile(join(directory, "tracked.ts"), "tracked\n"),
      writeFile(join(directory, "untracked.ts"), "untracked\n"),
    ]);  // RevExt: 47
    await execute("git", ["-C", directory, "add", "tracked.ts"]);
    assert.deepEqual(await new GitService().trackedPaths(directory), [
      "tracked.ts",
    ]);  // RevExt: 48
  } finally {  // RevExt: 50
    await rm(directory, { recursive: true, force: true });  // RevExt: 52
  }  // RevExt: 54
});  // RevExt: 39
// RevExt: 5
// RevExt: 38