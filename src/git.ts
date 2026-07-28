import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { RawGitHunk, Reviewer } from "./domain";

const execute = promisify(execFile);
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseGitHunks(output: string): readonly RawGitHunk[] {
  const result: RawGitHunk[] = [];
  for (const line of output.split("\n")) {
    const match = HUNK.exec(line);
    if (match === null) {
      continue;
    }
    result.push({
      oldStart: Number(match[1]),
      oldCount: Number(match[2] ?? "1"),
      newStart: Number(match[3]),
      newCount: Number(match[4] ?? "1"),
    });
  }
  return result;
}

export class GitService {
  async available(): Promise<boolean> {
    try {
      await execute("git", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async diff(
    baseline: Uint8Array,
    current: Uint8Array,
  ): Promise<readonly RawGitHunk[]> {
    const directory = await mkdtemp(join(tmpdir(), "code-review-tracker-"));
    const before = join(directory, "baseline");
    const after = join(directory, "current");
    const contentChanged = !sameBytes(baseline, current);
    try {
      await Promise.all([
        writeFile(before, baseline),
        writeFile(after, current),
      ]);
      const args = [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--text",
        "--unified=0",
        "--diff-algorithm=myers",
        "--indent-heuristic",
        "--",
        before,
        after,
      ];
      try {
        const result = await execute("git", args, {
          maxBuffer: 32 * 1024 * 1024,
        });
        if (contentChanged) {
          throw new Error("Git reported no diff for different file content");
        }
        return parseGitHunks(result.stdout);
      } catch (error) {
        const failure = error as Error & {
          code?: number | string;
          stdout?: string;
        };
        if (failure.code === 1 && typeof failure.stdout === "string") {
          if (!contentChanged) {
            throw new Error("Git reported changes for identical file content");
          }
          const hunks = parseGitHunks(failure.stdout);
          if (hunks.length === 0) {
            throw new Error(
              "Git returned a changed result without valid diff hunks",
            );
          }
          return hunks;
        }
        throw new Error(`Git diff failed: ${failure.message}`);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async ignoredPaths(
    directory: string,
    paths: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const ignored = new Set<string>();
    for (const pathsBatch of batches(paths, 500)) {
      try {
        addIgnoredPaths(
          ignored,
          await checkIgnoredPaths(directory, pathsBatch),
        );
      } catch {
        // A folder outside a Git worktree has no .gitignore rules to apply.
      }
    }
    return ignored;
  }

  async reviewer(
    folder: vscode.WorkspaceFolder | undefined,
  ): Promise<Reviewer | undefined> {
    if (folder === undefined) {
      return undefined;
    }
    const [name, email] = await Promise.all([
      gitConfig(folder, "user.name"),
      gitConfig(folder, "user.email"),
    ]);
    return name.length === 0
      ? undefined
      : email.length === 0
        ? { name }
        : { name, email };
  }
}

function* batches<T>(values: readonly T[], size: number): Generator<T[]> {
  for (let index = 0; index < values.length; index += size) {
    yield values.slice(index, index + size);
  }
}

function addIgnoredPaths(ignored: Set<string>, output: string): void {
  for (const path of output.split("\0")) {
    if (path.length > 0) {
      ignored.add(path);
    }
  }
}

function checkIgnoredPaths(
  directory: string,
  paths: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn("git", [
      "-C",
      directory,
      "check-ignore",
      "--no-index",
      "-z",
      "--stdin",
    ]);
    const output: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    process.once("error", reject);
    process.once("close", (code) => {
      if (code === 0 || code === 1) {
        resolve(Buffer.concat(output).toString());
        return;
      }
      reject(new Error(`Git check-ignore failed with exit code ${code}`));
    });
    process.stdin.end(`${paths.join("\0")}\0`);
  });
}

async function gitConfig(
  folder: vscode.WorkspaceFolder,
  key: string,
): Promise<string> {
  try {
    return (
      await execute("git", ["-C", folder.uri.fsPath, "config", "--get", key])
    ).stdout.trim();
  } catch {
    return "";
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}
