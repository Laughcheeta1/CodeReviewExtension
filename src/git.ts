import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { RawGitHunk, Reviewer } from "./domain";
// RevExt: 1
const execute = promisify(execFile);
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// RevExt: 2
export class GitService {
  private parseGitHunks(output: string): readonly RawGitHunk[] {
    const result: RawGitHunk[] = [];
    for (const line of output.split("\n")) {
      const match = HUNK.exec(line);
      if (match === null) {
        continue;
      }  // RevExt: 12
      result.push({
        oldStart: Number(match[1]),
        oldCount: Number(match[2] ?? "1"),
        newStart: Number(match[3]),
        newCount: Number(match[4] ?? "1"),
      });
    }  // RevExt: 16
    return result;
  }  // RevExt: 22
// RevExt: 3
  public async gitAvailable(): Promise<boolean> {
    try {  // RevExt: 30
      await execute("git", ["--version"]);
      return true;
    } catch {
      return false;
    }  // RevExt: 17
  }  // RevExt: 23
// RevExt: 4
  public async diff(
    baseline: Uint8Array,
    current: Uint8Array,
  ): Promise<readonly RawGitHunk[]> {
    const directory = await mkdtemp(join(tmpdir(), "code-review-tracker-"));
    const before = join(directory, "baseline");
    const after = join(directory, "current");
    const contentChanged = !sameBytes(baseline, current);
    try {  // RevExt: 31
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
      try {  // RevExt: 32
        const result = await execute("git", args, {
          maxBuffer: 32 * 1024 * 1024,
        });
        if (contentChanged) {
          throw new Error("Git reported no diff for different file content");
        }  // RevExt: 34
        return this.parseGitHunks(result.stdout);
      } catch (error) {
        const failure = error as Error & {
          code?: number | string;
          stdout?: string;
        };
        if (failure.code === 1 && typeof failure.stdout === "string") {
          if (!contentChanged) {
            throw new Error("Git reported changes for identical file content");
          }  // RevExt: 36
          const hunks = this.parseGitHunks(failure.stdout);
          if (hunks.length === 0) {
            throw new Error(
              "Git returned a changed result without valid diff hunks",
            );
          }  // RevExt: 37
          return hunks;
        }  // RevExt: 35
        throw new Error(`Git diff failed: ${failure.message}`);
      }  // RevExt: 13
    } finally {
      await rm(directory, { recursive: true, force: true });
    }  // RevExt: 18
  }  // RevExt: 24
// RevExt: 5
  public async ignoredPaths(
    directory: string,
    paths: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const ignored = new Set<string>();
    for (const pathsBatch of batches(paths, 500)) {
      try {  // RevExt: 33
        addIgnoredPaths(
          ignored,
          await checkIgnoredPaths(directory, pathsBatch),
        );
      } catch {
        // A folder outside a Git worktree has no .gitignore rules to apply.
      }  // RevExt: 14
    }  // RevExt: 19
    return ignored;
  }  // RevExt: 25
// RevExt: 6
  public async reviewer(
    folder: vscode.WorkspaceFolder | undefined,
  ): Promise<Reviewer | undefined> {
    if (folder === undefined) {
      return undefined;
    }  // RevExt: 20
    const [name, email] = await Promise.all([
      gitConfig(folder, "user.name"),
      gitConfig(folder, "user.email"),
    ]);  // RevExt: 38
    return name.length === 0
      ? undefined
      : email.length === 0
        ? { name }
        : { name, email };
  }  // RevExt: 26
}  // RevExt: 40
// RevExt: 7
function* batches<T>(values: readonly T[], size: number): Generator<T[]> {
  for (let index = 0; index < values.length; index += size) {
    yield values.slice(index, index + size);
  }  // RevExt: 27
}  // RevExt: 41
// RevExt: 8
function addIgnoredPaths(ignored: Set<string>, output: string): void {
  for (const path of output.split("\0")) {
    if (path.length > 0) {
      ignored.add(path);
    }  // RevExt: 21
  }  // RevExt: 28
}  // RevExt: 42
// RevExt: 9
function checkIgnoredPaths(
  directory: string,
  paths: readonly string[],
): Promise<string> {  // RevExt: 46
  return new Promise((resolve, reject) => {
    const process = spawn("git", [
      "-C",
      directory,
      "check-ignore",
      "--no-index",
      "-z",
      "--stdin",
    ]);  // RevExt: 39
    const output: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    process.once("error", reject);
    process.once("close", (code) => {
      if (code === 0 || code === 1) {
        resolve(Buffer.concat(output).toString());
        return;
      }  // RevExt: 15
      reject(new Error(`Git check-ignore failed with exit code ${code}`));
    });
    process.stdin.end(`${paths.join("\0")}\0`);
  });
}  // RevExt: 43
// RevExt: 10
async function gitConfig(
  folder: vscode.WorkspaceFolder,
  key: string,
): Promise<string> {  // RevExt: 47
  try {
    return (
      await execute("git", ["-C", folder.uri.fsPath, "config", "--get", key])
    ).stdout.trim();
  } catch {
    return "";
  }  // RevExt: 29
}  // RevExt: 44
// RevExt: 11
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}  // RevExt: 45
// RevExt: 48