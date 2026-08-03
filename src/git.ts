import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RawGitHunk, Reviewer } from "./domain";
// RevExt: 1
const execute = promisify(execFile);
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// RevExt: 2
export class GitService {
  constructor(private readonly executable = "git") {}

  public async reviewer(
    directory: string | undefined,
  ): Promise<Reviewer | undefined> {
    if (directory === undefined) {
      return undefined;
    }
    const [name, email] = await Promise.all([
      this.configValue(directory, "user.name"),
      this.configValue(directory, "user.email"),
    ]);
    if (name.length === 0) {
      return undefined;
    }
    return email.length === 0 ? { name } : { name, email };
  }

  private async configValue(directory: string, key: string): Promise<string> {
    try {
      const result = await execute(this.executable, [
        "-C",
        directory,
        "config",
        "--get",
        key,
      ]);
      return result.stdout.trim();
    } catch {
      return "";
    }
  }

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
  public async diff(
    baseline: Uint8Array,
    current: Uint8Array,
  ): Promise<readonly RawGitHunk[]> {
    const contentChanged = !sameBytes(baseline, current);
    if (!contentChanged) {
      return [];
    }
    const directory = await mkdtemp(join(tmpdir(), "code-review-tracker-"));
    const before = join(directory, "baseline");
    const after = join(directory, "current");
    try {  // RevExt: 31
      await Promise.all([
        writeFile(before, baseline),
        writeFile(after, current),
      ]);  // RevExt: 55
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
        const result = await execute(this.executable, args, {
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
}  // RevExt: 40
// RevExt: 11
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}  // RevExt: 45
// RevExt: 48
// RevExt: 49
