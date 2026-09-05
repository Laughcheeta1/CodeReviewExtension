import * as vscode from "vscode";
import { serialized } from "./concurrency";
import {
  createWorkspaceIgnoreMatcher,
  ignoredPathsFromMatcher,
  type WorkspaceIgnoreMatcher,
  type IgnoreFile,
} from "./ignore-matcher";

/**
 * Read and apply workspace .gitignore files without consulting Git.
 *
 * Git's repository-local info/exclude, global excludes, and Git configuration
 * are intentionally outside this service's input. This keeps eligibility
 * deterministic and avoids asking Git to resolve workspace paths, including
 * paths that pass through symbolic links.
 */
export class GitIgnoreService {
  private readonly matchersByWorkspace = new Map<
    string,
    WorkspaceIgnoreMatcher
  >();
  private readonly unavailableWorkspaces = new Set<string>();
  private readonly failuresByWorkspace = new Map<string, unknown>();
  private readonly refreshes = new Map<string, Promise<unknown>>();

  /** Refresh the rule snapshot at a workspace lifecycle boundary. */
  public async refresh(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.toString();
    await serialized(this.refreshes, key, async () => {
      try {
        const files = await this.readIgnoreFiles(folder);
        this.matchersByWorkspace.set(key, createWorkspaceIgnoreMatcher(files));
        this.unavailableWorkspaces.delete(key);
        this.failuresByWorkspace.delete(key);
      } catch (error) {
        this.unavailableWorkspaces.add(key);
        this.failuresByWorkspace.set(key, error);
        throw error;
      }
    });
  }

  public async ignoredPaths(
    folder: vscode.WorkspaceFolder,
    paths: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const key = folder.uri.toString();
    const activeRefresh = this.refreshes.get(key);
    if (activeRefresh !== undefined) {
      await activeRefresh;
    }
    this.throwIfUnavailable(key);
    let matcher = this.matchersByWorkspace.get(key);
    if (matcher === undefined) {
      try {
        const files = await this.readIgnoreFiles(folder);
        matcher = createWorkspaceIgnoreMatcher(files);
        this.matchersByWorkspace.set(key, matcher);
      } catch (error) {
        this.unavailableWorkspaces.add(key);
        this.failuresByWorkspace.set(key, error);
        throw error;
      }
    }
    try {
      return ignoredPathsFromMatcher(paths, matcher);
    } catch (error) {
      const failure = new Error(
        `Unable to evaluate workspace .gitignore rules for ${folder.uri.fsPath}: ${describeError(error)}`,
        { cause: error },
      );
      this.unavailableWorkspaces.add(key);
      this.failuresByWorkspace.set(key, failure);
      throw failure;
    }
  }

  private throwIfUnavailable(key: string): void {
    if (!this.unavailableWorkspaces.has(key)) {
      return;
    }
    const failure = this.failuresByWorkspace.get(key);
    throw failure instanceof Error
      ? failure
      : new Error("Workspace .gitignore rules are unavailable.");
  }

  private async readIgnoreFiles(
    folder: vscode.WorkspaceFolder,
  ): Promise<readonly IgnoreFile[]> {
    const excluded = new vscode.RelativePattern(
      folder,
      "**/{.git,node_modules,.vscode-test,.vscode/code-review-tracker}/**",
    );
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "**/.gitignore"),
      excluded,
    );
    return Promise.all(
      uris.map(async (uri) => {
        try {
          return {
            directory: directoryOf(relativePath(uri)),
            contents: new TextDecoder().decode(
              await vscode.workspace.fs.readFile(uri),
            ),
          };
        } catch (error) {
          throw new Error(
            `Unable to read .gitignore at ${uri.fsPath}: ${describeError(error)}`,
            { cause: error },
          );
        }
      }),
    );
  }
}

function relativePath(uri: vscode.Uri): string {
  return normalizePath(vscode.workspace.asRelativePath(uri, false));
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function directoryOf(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
