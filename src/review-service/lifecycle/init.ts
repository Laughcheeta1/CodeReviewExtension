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
    return;
  }
  const eligible = await deps.refreshEligiblePaths(folder);
  if (eligible === undefined) {
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
    if (await deps.withSource(uri, () => deps.recompute(uri, false, true))) {
      initialized += 1;
    }
  }
  if (initialized > 0) {
    deps.log.info(
      `Initialized review metadata for ${initialized} discovered files at startup.`,
    );
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
  if (!deps.isTrackableUri(uri)) {
    return false;
  }
  const initialized = await deps.withSource(uri, () =>
    deps.recompute(uri, false, true),
  );
  if (initialized) {
    deps.log.info(`Initialized review metadata for opened file ${path}.`);
    deps.notifyChanged(uri);
  }
  return initialized;
}
