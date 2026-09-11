import * as vscode from "vscode";
import type { LifecycleDeps } from "./deps";

export async function initializeOpenedDocument(
  deps: LifecycleDeps,
  document: vscode.TextDocument,
): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder === undefined) {
    return;
  }
  const store = deps.storeForFolder(folder);
  if (store === undefined || store.initializationState !== "initialized") {
    return;
  }
  await deps.refreshEligiblePaths(folder);
  if (document.isDirty) {
    return;
  }
  await initializeMissingSourceFor(deps, document.uri, folder);
}

export async function initializeSource(
  deps: LifecycleDeps,
  uri: vscode.Uri,
): Promise<void> {
  await initializeMissingSource(deps, uri);
}

export async function initializeDiscoveredSources(
  deps: LifecycleDeps,
  folder: vscode.WorkspaceFolder,
): Promise<void> {
  const store = deps.storeForFolder(folder);
  if (store === undefined || store.initializationState !== "initialized") {
    deps.log.info(
      `Skipping discovered-source initialization for ${folder.uri.fsPath}: ` +
        `store=${store === undefined ? "missing" : store.initializationState}.`,
    );
    return;
  }
  const eligible = await deps.refreshEligiblePaths(folder);
  if (eligible === undefined) {
    deps.log.warn(
      `Skipping discovered-source initialization for ${folder.uri.fsPath}: eligible paths could not be enumerated.`,
    );
    return;
  }
  await store.includeTrackingTargets(
    eligible.map((path) => ({ kind: "file" as const, path })),
  );
  deps.setEligiblePaths(folder, eligible);
  const paths = eligible.filter((path) => store.summary(path) === undefined);
  let initialized = 0;
  for (const path of paths) {
    const uri = vscode.Uri.joinPath(folder.uri, ...path.split("/"));
    try {
      if (await deps.withSource(uri, () => deps.recompute(uri, false, true))) {
        initialized += 1;
      }
    } catch (error) {
      deps.log.warn(
        `Skipping discovered-source initialization of "${path}" in ${folder.uri.fsPath} ` +
          `at ${uri.toString()}: ${String(error)}`,
      );
    }
  }
  deps.log.info(
    `Discovered-source initialization for ${folder.uri.fsPath}: ` +
      `eligible=${eligible.length}, missing=${paths.length}, initialized=${initialized}.`,
  );
  if (initialized > 0) {
    deps.notifyChanged();
  }
}

export async function initializeMissingSource(
  deps: LifecycleDeps,
  uri: vscode.Uri,
): Promise<boolean> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder === undefined) {
    return false;
  }
  return initializeMissingSourceFor(deps, uri, folder);
}

async function initializeMissingSourceFor(
  deps: LifecycleDeps,
  uri: vscode.Uri,
  folder: vscode.WorkspaceFolder,
): Promise<boolean> {
  const path = deps.relativePath(uri);
  const store = deps.storeFor(uri);
  if (
    path === undefined ||
    store === undefined ||
    store.initializationState !== "initialized"
  ) {
    return false;
  }
  if (!(await deps.ensureIncludes(folder, path))) {
    return false;
  }
  if (deps.dirtyDocument(uri) !== undefined) {
    return false;
  }
  await store.includeTrackingTarget({ kind: "file", path });
  deps.trackPath(folder, path);
  if (!deps.isTrackableUri(uri)) {
    return false;
  }
  const initialized = await deps.withSource(uri, () =>
    deps.recompute(uri, false, true),
  );
  if (initialized) {
    deps.log.info(
      `Initialized review metadata for "${path}" in ${folder.uri.fsPath} at ${uri.toString()}.`,
    );
    deps.notifyChanged(uri);
  }
  return initialized;
}
