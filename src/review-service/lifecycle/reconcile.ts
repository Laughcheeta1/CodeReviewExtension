import * as vscode from "vscode";
import {
  isExcludedPath,
  isFileNotFound,
  progressIncrement,
} from "../../review-service-utils";
import { recomputeExternalSource } from "../../revext-annotation";
import type { LifecycleDeps } from "./deps";
import { initializeMissingSource } from "./init";

export async function reconcileExternalChanges(
  deps: LifecycleDeps,
  folder: vscode.WorkspaceFolder,
  force = false,
): Promise<void> {
  const store = deps.storeForFolder(folder);
  if (store === undefined) {
    return;
  }
  if (store.initializationState !== "initialized") {
    return;
  }
  const eligible = deps.trackedPaths(folder);
  let changed = 0;
  let hidden = 0;
  const paths = new Set(eligible ?? []);
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Code Review: updating files",
    },
    async (progress) => {
      let completed = 0;
      progress.report({ message: `0/${paths.size}` });
      const pathList = [...paths];
      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          const path = pathList[index];
          if (path === undefined) {
            return;
          }
          const uri = vscode.Uri.joinPath(folder.uri, ...path.split("/"));
          try {
            if (
              await deps.withSource(uri, () =>
                deps.recompute(uri, force, true),
              )
            ) {
              changed += 1;
            }
          } catch (error) {
            if (!isFileNotFound(error)) {
              deps.log.warn(
                `Review recomputation failed for ${path}; existing state was preserved: ${String(error)}`,
              );
            } else {
              if (eligible !== undefined && deps.untrackPath(folder, path)) {
                hidden += 1;
              }
            }
          } finally {
            completed += 1;
            progress.report({
              increment: progressIncrement(paths.size),
              message: `${completed}/${paths.size}`,
            });
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(4, pathList.length) },
          () => worker(),
        ),
      );
    },
  );
  if (changed > 0 || hidden > 0) {
    deps.log.info(
      `Review reconciliation updated ${changed} and hid ${hidden} missing files.`,
    );
    deps.notifyChanged();
  }
}

export async function refreshReviewPolicy(deps: LifecycleDeps): Promise<void> {
  let changed = false;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const store = deps.storeForFolder(folder);
    if (
      store === undefined ||
      store.initializationState !== "initialized"
    ) {
      continue;
    }
    const eligible = await deps.refreshEligiblePaths(folder);
    if (eligible === undefined) {
      continue;
    }
    for (const path of eligible) {
      if (!store.tracksPath(path)) {
        continue;
      }
      const uri = vscode.Uri.joinPath(folder.uri, ...path.split("/"));
      try {
        if (
          await deps.withSource(uri, () =>
            deps.recompute(uri, true, false, undefined, undefined, true),
          )
        ) {
          changed = true;
        }
      } catch (error) {
        deps.log.warn(
          `Could not refresh review policy for ${path}: ${String(error)}`,
        );
      }
    }
  }
  if (changed) {
    deps.notifyChanged();
  }
}

export async function reconcileCreatedSource(
  deps: LifecycleDeps,
  uri: vscode.Uri,
): Promise<void> {
  const path = deps.relativePath(uri);
  const store = deps.storeFor(uri);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (
    path === undefined ||
    store === undefined ||
    folder === undefined ||
    store.initializationState !== "initialized" ||
    store.owns(uri) ||
    isExcludedPath(path)
  ) {
    return;
  }
  const eligible = await deps.refreshEligiblePaths(folder, true);
  if (eligible === undefined || !eligible.includes(path)) {
    return;
  }
  if (!(await initializeMissingSource(deps, uri))) {
    return;
  }
  deps.trackPath(folder, path);
  deps.notifyChanged(uri);
}

export async function reconcileExternalSource(
  deps: LifecycleDeps,
  uri: vscode.Uri,
): Promise<void> {
  if (uri.scheme !== "file") {
    return;
  }
  const path = deps.relativePath(uri);
  const store = deps.storeFor(uri);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (
    path === undefined ||
    store === undefined ||
    folder === undefined ||
    store.initializationState !== "initialized" ||
    store.owns(uri) ||
    isExcludedPath(path)
  ) {
    return;
  }
  const eligible = await deps.refreshEligiblePaths(folder, true);
  if (
    eligible === undefined ||
    !eligible.includes(path) ||
    !store.tracksPath(path)
  ) {
    return;
  }
  try {
    const changed = await deps.withSource(uri, () =>
      recomputeExternalSource(deps.annotationContext(), uri),
    );
    if (changed) {
      deps.notifyChanged(uri);
    }
  } catch (error) {
    if (isFileNotFound(error)) {
      deps.hideSources([uri]);
      return;
    }
    deps.log.warn(
      `Could not reconcile externally changed source ${path}: ${String(error)}`,
    );
  }
}

export async function reconcileSavedDocument(
  deps: LifecycleDeps,
  document: vscode.TextDocument,
): Promise<void> {
  if (document.uri.scheme !== "file") {
    return;
  }
  const internalKey = document.uri.toString();
  if (deps.consumeInternalSave(internalKey)) {
    return;
  }
  const store = deps.storeFor(document.uri);
  const path = deps.relativePath(document.uri);
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (
    store === undefined ||
    path === undefined ||
    folder === undefined ||
    store.initializationState !== "initialized"
  ) {
    return;
  }
  if (!(await deps.ensureIncludes(folder, path))) {
    return;
  }
  if (!store.tracksPath(path)) {
    await initializeMissingSource(deps, document.uri);
  }
  if (!store.tracksPath(path)) {
    return;
  }
  deps.trackPath(folder, path);
  try {
    await deps.withSource(document.uri, () =>
      deps.recomputeSavedDocument(document),
    );
    deps.notifyChanged(document.uri);
  } catch (error) {
    deps.log.warn(
      `Could not reconcile saved source ${deps.relativePath(document.uri) ?? document.uri.toString()}: ${String(error)}`,
    );
  }
}
