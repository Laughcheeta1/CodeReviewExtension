import * as vscode from "vscode";
import { forEachConcurrent, STORE_CONCURRENCY_LIMIT } from "../../concurrency";
import { isFileNotFound } from "../../review-service-utils";
import type { CleanupDeps } from "./deps";

export async function cleanupMissingSources(
  deps: CleanupDeps,
  folder: vscode.WorkspaceFolder,
): Promise<void> {
  const store = deps.storeForFolder(folder);
  if (store === undefined) {
    return;
  }
  let removed = 0;
  const snapshot = [...store.paths];
  // Sequential deletion preserves store ordering semantics; use bounded stat concurrency to detect missing files faster
  const missing: string[] = [];
  await forEachConcurrent(snapshot, STORE_CONCURRENCY_LIMIT, async (path) => {
    const uri = vscode.Uri.joinPath(folder.uri, ...path.split("/"));
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.File) !== 0) {
        return;
      }
    } catch (error) {
      if (!isFileNotFound(error)) {
        deps.log.warn(
          `Could not check whether ${path} still exists: ${String(error)}`,
        );
        return;
      }
    }
    missing.push(path);
  });
  for (const path of missing) {
    await store.delete(path);
    removed += 1;
  }
  if (removed > 0) {
    deps.log.info(`Removed metadata for ${removed} missing files at startup.`);
    deps.notifyChanged();
  }
}

export async function cleanupIgnoredSources(
  deps: CleanupDeps,
  folder: vscode.WorkspaceFolder,
  ignoredPaths: (
    folder: vscode.WorkspaceFolder,
    paths: readonly string[],
  ) => Promise<ReadonlySet<string>>,
): Promise<void> {
  const store = deps.storeForFolder(folder);
  if (store === undefined || store.paths.length === 0) {
    return;
  }
  let ignored: ReadonlySet<string>;
  try {
    ignored = await ignoredPaths(folder, store.paths);
  } catch (error) {
    deps.log.warn(
      `Could not evaluate ignored sources; existing metadata was preserved: ${String(error)}`,
    );
    return;
  }
  let removed = 0;
  for (const path of ignored) {
    const uri = vscode.Uri.joinPath(folder.uri, ...path.split("/"));
    try {
      await deps.withSource(uri, async () => {
        // A source write or another ignore refresh can finish while cleanup
        // waits for this source. Recheck the rules inside the write gate.
        if (!(await ignoredPaths(folder, [path])).has(path)) {
          return;
        }
        await store.delete(path);
        removed += 1;
      });
    } catch (error) {
      deps.log.warn(
        `Could not clean up ignored source ${path}; existing metadata was preserved: ${String(error)}`,
      );
    }
  }
  if (removed > 0) {
    deps.log.info(`Removed metadata for ${removed} ignored files.`);
    deps.notifyChanged();
  }
}
