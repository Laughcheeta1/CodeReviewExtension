import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitBlameLine, RawGitHunk, Reviewer } from "./domain/types";

export type { GitBlameLine } from "./domain/types";

const execute = promisify(execFile);
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const BLAME_HEADER =
  /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/;

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

  /**
   * Blame the current file once and return per-line authorship.
   *
   * Uses `--line-porcelain` so authorship does not depend on display
   * formatting. Callers must treat failures as unknown attribution and
   * fall back to a conservative pending state.
   */
  public async blame(
    repository: string,
    relativePath: string,
  ): Promise<ReadonlyMap<number, GitBlameLine>> {
    const args = [
      "-C",
      repository,
      "blame",
      "--line-porcelain",
      "--",
      relativePath,
    ];
    try {
      const result = await execute(this.executable, args, {
        maxBuffer: 32 * 1024 * 1024,
      });
      return parseBlamePorcelain(result.stdout);
    } catch (error) {
      const failure = error as Error & {
        code?: number | string;
        stdout?: string;
      };
      throw new Error(`Git blame failed: ${failure.message}`);
    }
  }

  private parseGitHunks(output: string): readonly RawGitHunk[] {
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
        "--inter-hunk-context=0",
        "--diff-algorithm=myers",
        "--indent-heuristic",
        "--",
        before,
        after,
      ];
      try {
        await execute(this.executable, args, {
          maxBuffer: 32 * 1024 * 1024,
        });
        throw new Error("Git reported no diff for different file content");
      } catch (error) {
        const failure = error as Error & {
          code?: number | string;
          stdout?: string;
        };
        if (failure.code === 1 && typeof failure.stdout === "string") {
          const hunks = this.parseGitHunks(failure.stdout);
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
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Parse `git blame --line-porcelain` output into per-line authorship.
 *
 * Each block starts with `<commit> <orig> <final> [<count>]`, followed
 * by author metadata and one TAB-prefixed content line. The optional count
 * describes the group, whose remaining lines still have their own blocks.
 * The map is keyed by final (current-file)
 * one-based line numbers so callers can classify snapshot-diff additions.
 */
export function parseBlamePorcelain(
  output: string,
): ReadonlyMap<number, GitBlameLine> {
  const result = new Map<number, GitBlameLine>();
  const lines = output.split("\n");
  let index = 0;
  while (index < lines.length) {
    const header = BLAME_HEADER.exec(lines[index] ?? "");
    if (header === null) {
      index += 1;
      continue;
    }
    const commit = header[1] ?? "";
    const finalLine = Number(header[3] ?? "0");
    let authorName: string | undefined;
    let authorEmail: string | undefined;
    index += 1;
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (current.startsWith("\t")) {
        break;
      }
      if (BLAME_HEADER.test(current)) {
        break;
      }
      if (current.startsWith("author ")) {
        const value = current.slice("author ".length).trim();
        if (value.length > 0) {
          authorName = value;
        }
      } else if (current.startsWith("author-mail ")) {
        const value = current.slice("author-mail ".length).trim();
        const stripped = value.startsWith("<") && value.endsWith(">")
          ? value.slice(1, -1).trim()
          : value;
        if (stripped.length > 0) {
          authorEmail = stripped;
        }
      } else if (current.startsWith("filename ")) {
        // Filenames can contain spaces; no parsing is required here.
      }
      index += 1;
    }
    if ((lines[index] ?? "").startsWith("\t")) {
      result.set(finalLine, {
        line: finalLine,
        authorName,
        authorEmail,
        commit,
      });
      index += 1;
    }
  }
  return result;
}
