import * as vscode from "vscode";
import { coalesced } from "../concurrency";
import { errorMessage } from "../errors";
import { isExcludedPath } from "../review-service-utils";
import { eligibleWorkspacePaths } from "../workspace-discovery";
import type { GitIgnoreService } from "../git-ignore";
import type { PersistentStore } from "../store";

/** Workspace-relative path with normalized separators, if resolvable. */
export function relativePath(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder === undefined
    ? undefined
    : vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/");
}

/**
 * Owns the eligible-path snapshot per workspace folder and answers every
 * ignore/trackability question through the shared Git-ignore guard, so no
 * lifecycle path can invent its own eligibility rule.
 */
export class EligibilityTracker {
  private readonly eligiblePaths = new Map<string, Set<string>>();
  private readonly discoveredPaths = new Map<string, readonly string[]>();
  private readonly refreshes = new Map<
    string,
    Promise<readonly string[] | undefined>
  >();

  constructor(
    private readonly stores: Map<string, PersistentStore>,
    private readonly ignoreRules: GitIgnoreService,
    private readonly log: vscode.LogOutputChannel,
    private readonly notifyChanged: () => void,
  ) {}

  setEligiblePaths(
    folder: vscode.WorkspaceFolder,
    paths: readonly string[],
  ): void {
    const key = folder.uri.toString();
    const store = this.stores.get(key);
    const discovered = [...paths];
    this.discoveredPaths.set(key, discovered);
    const next = new Set(
      discovered.filter((path) => store?.tracksPath(path)),
    );
    const previous = this.eligiblePaths.get(key);
    this.eligiblePaths.set(key, next);
    if (
      previous === undefined ||
      previous.size !== next.size ||
      [...previous].some((path) => !next.has(path))
    ) {
      this.notifyChanged();
    }
  }

  /** Currently tracked eligible paths for iteration; mutated only via track/untrack. */
  trackedPaths(folder: vscode.WorkspaceFolder): ReadonlySet<string> | undefined {
    return this.eligiblePaths.get(folder.uri.toString());
  }

  trackPath(folder: vscode.WorkspaceFolder, path: string): void {
    this.eligiblePaths.get(folder.uri.toString())?.add(path);
  }

  untrackPath(folder: vscode.WorkspaceFolder, path: string): boolean {
    return (
      this.eligiblePaths.get(folder.uri.toString())?.delete(path) ?? false
    );
  }

  /**
   * Refresh discovery and answer whether a path is currently eligible,
   * retrying once with a forced refresh when the cached snapshot misses it.
   */
  async ensureIncludes(
    folder: vscode.WorkspaceFolder,
    path: string,
  ): Promise<boolean> {
    let eligible = await this.refreshEligiblePaths(folder);
    if (eligible !== undefined && !eligible.includes(path)) {
      eligible = await this.refreshEligiblePaths(folder, true);
    }
    return eligible !== undefined && eligible.includes(path);
  }

  async refreshEligiblePaths(
    folder: vscode.WorkspaceFolder,
    force = false,
  ): Promise<readonly string[] | undefined> {
    const key = folder.uri.toString();
    if (!force) {
      const cached = this.discoveredPaths.get(key);
      if (cached !== undefined) {
        return cached;
      }
    }
    return coalesced(this.refreshes, key, async () => {
      try {
        const eligible = await eligibleWorkspacePaths(folder, this.ignoreRules);
        this.setEligiblePaths(folder, eligible);
        return eligible;
      } catch (error) {
        this.log.warn(
          `Could not refresh ignore-rule eligibility for ${folder.uri.fsPath}: ${errorMessage(error)}`,
        );
        return undefined;
      }
    });
  }

  async isEligibleSource(uri: vscode.Uri): Promise<boolean> {
    if (!this.isEligibleSourceUri(uri)) {
      return false;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const path = relativePath(uri);
    if (folder === undefined || path === undefined) {
      return false;
    }
    try {
      return !(await this.ignoreRules.ignoredPaths(folder, [path])).has(path);
    } catch {
      return false;
    }
  }

  isTrackableUri(uri: vscode.Uri): boolean {
    if (!this.isEligibleSourceUri(uri)) {
      return false;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder === undefined) {
      return false;
    }
    return (
      this.eligiblePaths
        .get(folder.uri.toString())
        ?.has(relativePath(uri) ?? "") ?? false
    );
  }

  isEligibleSourceUri(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file") {
      return false;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder === undefined) {
      return false;
    }
    const store = this.stores.get(folder.uri.toString());
    const path = relativePath(uri);
    return (
      store?.owns(uri) !== true && path !== undefined && !isExcludedPath(path)
    );
  }
}
