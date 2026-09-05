import * as vscode from "vscode";
import { isFileNotFound } from "../../review-service-utils";
import type { LifecycleDeps } from "./deps";

export async function cleanupMissingSources(
  deps: LifecycleDeps,
  folder: vscode.WorkspaceFolder,
): Promise<void> {
  const store = deps.storeForFolder(folder);
  if (store === undefined) {
    return;
  }
  let removed = 0;
  for (const path of store.paths) {
    const uri = vscode.Uri.joinPath(folder.uri, ...path.split("/"));
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.File) !== 0) {
        continue;
      }
    } catch (error) {
      if (!isFileNotFound(error)) {
        deps.log.warn(
          `Could not check whether ${path} still exists: ${String(error)}`,
        );
        continue;
      }
    }
    await store.delete(path);
    removed += 1;
  }
  if (removed > 0) {
    deps.log.info(`Removed metadata for ${removed} missing files at startup.`);
    deps.notifyChanged();
  }
}

export async function cleanupIgnoredSources(
  deps: LifecycleDeps,
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
  for (const path of ignored) {
    await store.delete(path);
  }
  if (ignored.size > 0) {
    deps.log.info(`Removed metadata for ${ignored.size} ignored files.`);
    deps.notifyChanged();
  }
}
