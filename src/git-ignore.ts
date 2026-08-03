import * as vscode from "vscode";
import {
  ignoredPathsFromFiles,
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
  private readonly filesByWorkspace = new Map<
    string,
    readonly IgnoreFile[]
  >();
  private readonly unavailableWorkspaces = new Set<string>();
  private readonly failuresByWorkspace = new Map<string, unknown>();
  private readonly refreshes = new Map<string, Promise<void>>();

  /** Refresh the rule snapshot at a workspace lifecycle boundary. */
  public async refresh(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.toString();
    const previous = this.refreshes.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      try {
        this.filesByWorkspace.set(key, await this.readIgnoreFiles(folder));
        this.unavailableWorkspaces.delete(key);
        this.failuresByWorkspace.delete(key);
      } catch (error) {
        this.unavailableWorkspaces.add(key);
        this.failuresByWorkspace.set(key, error);
        throw error;
      }
    });
    this.refreshes.set(key, current);
    try {
      await current;
    } finally {
      if (this.refreshes.get(key) === current) {
        this.refreshes.delete(key);
      }
    }
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
    let files = this.filesByWorkspace.get(key);
    if (files === undefined) {
      try {
        files = await this.readIgnoreFiles(folder);
        this.filesByWorkspace.set(key, files);
      } catch (error) {
        this.unavailableWorkspaces.add(key);
        this.failuresByWorkspace.set(key, error);
        throw error;
      }
    }
    try {
      return ignoredPathsFromFiles(paths, files);
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
      "**/{.git,node_modules,.vscode/code-review-tracker}/**",
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
