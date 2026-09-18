import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { GitService, parseBlamePorcelain } from "../src/git.ts";
import {
  initialStatusCallback,
  initialStatusForBlameLine,
  isCurrentUserLine,
} from "../src/domain/blame.ts";
import { buildDiffRecords } from "../src/domain/diff.ts";
import type { FileRecord } from "../src/domain/types.ts";

const execute = promisify(execFile);
const encoder = new TextEncoder();
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const ZERO = "0".repeat(40);

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

test("parseBlamePorcelain handles continuation headers, brackets, zero commit, spaces", () => {
  const output = [
    `${COMMIT_A} 1 1 2`,
    "author Alice",
    "author-mail <Alice@Example.com>",
    "filename foo.ts",
    "\tline one",
    `${COMMIT_A} 2 2`,
    "author Alice",
    "author-mail <Alice@Example.com>",
    "filename foo.ts",
    "\tline two",
    `${ZERO} 3 3 1`,
    "author Not Committed Yet",
    "author-mail <not.committed.yet>",
    "filename my file with spaces.ts",
    "\tuncommitted",
    "",
  ].join("\n");
  const parsed = parseBlamePorcelain(output);
  assert.equal(parsed.size, 3);
  assert.deepEqual(parsed.get(1), {
    line: 1,
    authorName: "Alice",
    authorEmail: "Alice@Example.com",
    commit: COMMIT_A,
  });
  assert.equal(parsed.get(2)?.commit, COMMIT_A);
  const uncommitted = parsed.get(3);
  assert.ok(uncommitted !== undefined);
  assert.equal(uncommitted.commit, ZERO);
  assert.ok(/^0+$/.test(uncommitted.commit));
  assert.equal(uncommitted.authorEmail, "not.committed.yet");
});

for (const objectFormat of ["sha1", "sha256"]) {
  test(`GitService.blame attributes every line of a multi-line ${objectFormat} commit`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "code-review-blame-group-"));
    try {
      await execute("git", ["init", "--quiet", `--object-format=${objectFormat}`, directory]);
      await execute("git", ["-C", directory, "config", "user.name", "Alice"]);
      await execute("git", ["-C", directory, "config", "user.email", "a@x.test"]);
      await writeFile(join(directory, "file.txt"), "one\ntwo\nthree\n");
      await execute("git", ["-C", directory, "add", "file.txt"]);
      await execute("git", ["-C", directory, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "init"]);
      await writeFile(join(directory, "file.txt"), "one\ntwo\nthree\nnew one\nnew two\n");
      const blame = await new GitService().blame(directory, "file.txt");
      assert.deepEqual([...blame.keys()], [1, 2, 3, 4, 5]);
      for (const line of [1, 2, 3]) {
        assert.equal(blame.get(line)?.authorEmail, "a@x.test");
        assert.equal(initialStatusForBlameLine(blame.get(line), { name: "Bob", email: "b@x.test" }), "reviewed");
      }
      for (const line of [4, 5]) {
        assert.match(blame.get(line)?.commit ?? "", /^0+$/);
        assert.equal(initialStatusForBlameLine(blame.get(line), { name: "Bob" }), "pending");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }


  });
}

test("malformed blame blocks do not inherit the next block's content or author", () => {
  const parsed = parseBlamePorcelain([
    `${COMMIT_A} 1 1 1`,
    "author Alice",
    `${COMMIT_B} 2 2 1`,
    "author Bob",
    "author-mail <bob@example.test>",
    "\tsecond line",
  ].join("\n"));
  assert.equal(parsed.has(1), false);
  assert.equal(parsed.size, 1);
  assert.equal(parsed.get(2)?.authorName, "Bob");
});

test("blame identity: email case/trim, name fallback, status mapping", () => {
  const me = { name: "Santiago", email: "santiago@example.com" };
  const emailMatch = {
    line: 1,
    commit: COMMIT_A,
    authorName: "Someone",
    authorEmail: "  SANTIAGO@EXAMPLE.COM  ",
  };
  assert.equal(isCurrentUserLine(emailMatch, me), true);
  assert.equal(initialStatusForBlameLine(emailMatch, me), "pending");
  const nameMatch = { line: 1, commit: COMMIT_A, authorName: "  Santiago  " };
  assert.equal(isCurrentUserLine(nameMatch, me), true);
  assert.equal(initialStatusForBlameLine(nameMatch, me), "pending");
  const other = {
    line: 1,
    commit: COMMIT_A,
    authorName: "Alice",
    authorEmail: "alice@example.com",
  };
  assert.equal(isCurrentUserLine(other, me), false);
  assert.equal(initialStatusForBlameLine(other, me), "reviewed");
  const uncommitted = {
    line: 1,
    commit: ZERO,
    authorName: "Alice",
    authorEmail: "alice@example.com",
  };
  assert.equal(isCurrentUserLine(uncommitted, me), true);
  assert.equal(initialStatusForBlameLine(uncommitted, me), "pending");
  assert.equal(initialStatusForBlameLine(undefined, me), "pending");
  assert.equal(initialStatusForBlameLine(other, undefined), "pending");
  assert.equal(
    initialStatusForBlameLine({ line: 1, commit: COMMIT_A }, me),
    "pending",
  );
  const callback = initialStatusCallback(
    new Map([[2, other]]),
    me,
  );
  assert.equal(callback(2), "reviewed");
  assert.equal(callback(9), "pending");
});

test("additions classify by blame, transfers win over classifier", () => {
  const me = { name: "Santiago", email: "santiago@example.com" };
  const otherBlame = new Map([
    [2, { line: 2, commit: COMMIT_A, authorName: "A", authorEmail: "a@x.test" }],
  ]);
  const mineBlame = new Map([
    [
      2,
      {
        line: 2,
        commit: COMMIT_B,
        authorName: "Santiago",
        authorEmail: "santiago@example.com",
      },
    ],
  ]);
  const hunks = [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 }];
  const byOther = buildDiffRecords(bytes("a\n"), bytes("a\nnew\n"), hunks, undefined, {
    initialStatusForAddition: initialStatusCallback(otherBlame, me),
  });
  assert.equal(byOther.currentLines[1]?.reviewStatus, "reviewed");
  const byMe = buildDiffRecords(bytes("a\n"), bytes("a\nnew\n"), hunks, undefined, {
    initialStatusForAddition: initialStatusCallback(mineBlame, me),
  });
  assert.equal(byMe.currentLines[1]?.reviewStatus, "pending");
  const previous = {
    currentLines: byOther.currentLines.map((line) => ({
      ...line,
      reviewStatus: "reviewed" as const,
    })),
    deletedLines: [],
  } as unknown as FileRecord;
  const rebuilt = buildDiffRecords(bytes("a\n"), bytes("a\nnew\n"), hunks, previous, {
    initialStatusForAddition: () => "pending" as const,
  });
  assert.equal(rebuilt.currentLines[1]?.reviewStatus, "reviewed");
});

test("pure deletion stays pending without blame inheritance", () => {
  const diff = buildDiffRecords(bytes("a\nb\n"), bytes("a\n"), [
    { oldStart: 2, oldCount: 1, newStart: 2, newCount: 0 },
  ], undefined, { initialStatusForAddition: () => "reviewed" });
  assert.equal(diff.deletedLines.length, 1);
  assert.equal(diff.deletedLines[0]?.reviewStatus, "pending");
});

test("changed duplicate counts stay pending even when blame classifies them as reviewed", () => {
  for (const [beforeCount, afterCount] of [[2, 1], [1, 2], [2, 3]]) {
    const before = buildDiffRecords(bytes(""), bytes("same\n".repeat(beforeCount!)), [
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: beforeCount! },
    ]);
    const previous = {
      ...before,
      currentLines: before.currentLines.map((line) => ({
        ...line,
        reviewStatus: "inReview" as const,
      })),
    } as unknown as FileRecord;
    const classified: number[] = [];
    const result = buildDiffRecords(
      bytes(""), bytes(`${"same\n".repeat(afterCount!)}new\n`),
      [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: afterCount! + 1 }],
      previous,
      {
        initialStatusForAddition: (line) => {
          classified.push(line);
          return "reviewed";
        },
        initialReviewerForAddition: () => ({ name: "Alice", email: "alice@example.com", time: "2026-01-01T00:00:00.000Z" }),
      },
    );
    assert.deepEqual(result.currentLines.slice(0, afterCount).map((line) => line.reviewStatus), Array(afterCount).fill("pending"));
    assert.ok(result.currentLines.slice(0, afterCount).every((line) => line.lastReviewer === undefined));
    assert.equal(result.currentLines.at(-1)?.reviewStatus, "reviewed");
    assert.deepEqual(classified, [afterCount! + 1]);
  }
});

test("1-1 replacement inherits, 2-2 hunk stays conservative", () => {
  const me = { name: "Santiago", email: "santiago@example.com" };
  const hunk = [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }];
  const other = new Map([
    [2, { line: 2, commit: COMMIT_A, authorName: "A", authorEmail: "a@x.test" }],
  ]);
  const mine = new Map([
    [
      2,
      {
        line: 2,
        commit: COMMIT_B,
        authorName: "Santiago",
        authorEmail: "santiago@example.com",
      },
    ],
  ]);
  const reviewed = buildDiffRecords(bytes("a\nold\n"), bytes("a\nnew\n"), hunk, undefined, {
    initialStatusForAddition: initialStatusCallback(other, me),
  });
  assert.equal(reviewed.currentLines[1]?.reviewStatus, "reviewed");
  assert.equal(reviewed.deletedLines[0]?.reviewStatus, "reviewed");
  const pending = buildDiffRecords(bytes("a\nold\n"), bytes("a\nnew\n"), hunk, undefined, {
    initialStatusForAddition: initialStatusCallback(mine, me),
  });
  assert.equal(pending.currentLines[1]?.reviewStatus, "pending");
  assert.equal(pending.deletedLines[0]?.reviewStatus, "pending");
  const wide = buildDiffRecords(bytes("o1\no2\n"), bytes("n1\nn2\n"), [
    { oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 },
  ], undefined, { initialStatusForAddition: () => "reviewed" });
  assert.deepEqual(
    wide.currentLines.map((line) => line.reviewStatus),
    ["reviewed", "reviewed"],
  );
  assert.deepEqual(
    wide.deletedLines.map((line) => line.reviewStatus),
    ["pending", "pending"],
  );
});

test("GitService.blame maps committed lines and zero-commit edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-review-blame-"));
  try {
    await execute("git", ["init", "--quiet", directory]);
    await execute("git", ["-C", directory, "config", "user.name", "Alice"]);
    await execute("git", ["-C", directory, "config", "user.email", "a@x.test"]);
    await writeFile(join(directory, "file.txt"), "one\n");
    await execute("git", ["-C", directory, "add", "file.txt"]);
    await execute("git", ["-C", directory, "commit", "--quiet", "-m", "init"]);
    await writeFile(join(directory, "file.txt"), "one\nuncommitted\n");
    const blame = await new GitService().blame(directory, "file.txt");
    assert.equal(blame.size, 2);
    assert.equal(blame.get(1)?.authorEmail, "a@x.test");
    assert.ok(/^0+$/.test(blame.get(2)?.commit ?? "x"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GitService.blame throws /Git blame failed/ for bad executable", async () => {
  await assert.rejects(
    new GitService("git-executable-that-does-not-exist").blame(".", "file.txt"),
    /Git blame failed/,
  );
});
