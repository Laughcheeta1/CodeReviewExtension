import * as vscode from "vscode";
import {
  initialAdditionHunks,
  now,
  progressIncrement,
} from "../../review-service-utils";
import { createRecord, readStableSource } from "../../source-io";
import { tracksPath, type TrackingTarget } from "../../tracking";
import type { LifecycleDeps } from "./deps";

export async function initializeFolder(
  deps: LifecycleDeps,
  folder: vscode.WorkspaceFolder,
  status: "pending" | "reviewed",
  targets?: readonly TrackingTarget[],
  candidatePaths?: readonly string[],
): Promise<void> {
  const store = deps.storeForFolder(folder);
  if (store === undefined) {
    return;
  }
  const eligible = candidatePaths ?? deps.trackedPaths(folder);
  if (eligible === undefined) {
    throw new Error("Workspace files have not been enumerated.");
  }
  const configuredTargets = targets ?? store.trackingTargets();
  if (configuredTargets === undefined) {
    throw new Error("Choose files or folders before initializing review tracking.");
  }
  if (!deps.tryBeginInitialization(folder)) {
    throw new Error("This workspace is already being initialized.");
  }
  try {
    await deps.drainSources();
    await store.reset();
    const maxSize = deps.maxSize();
    const paths = [...eligible]
      .filter((path) => tracksPath(path, {
        schemaVersion: 1,
        state: "initialized",
        targets: configuredTargets,
      }))
      .sort();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Code Review: adding ${status} files`,
      },
      async (progress) => {
        let completed = 0;
        progress.report({ message: `0/${paths.length}` });
        for (const path of paths) {
          const uri = vscode.Uri.joinPath(folder.uri, ...path.split("/"));
          try {
            await initializeOneFile(deps, folder, uri, path, status, maxSize);
          } catch (error) {
            deps.log.warn(`Skipping ${path}: ${String(error)}`);
          } finally {
            completed += 1;
            progress.report({
              increment: progressIncrement(paths.length),
              message: `${completed}/${paths.length}`,
            });
          }
        }
      },
    );
    await store.enableTracking(configuredTargets);
    deps.setEligiblePaths(folder, paths);
    deps.notifyChanged();
  } finally {
    deps.endInitialization(folder);
  }
}

async function initializeOneFile(
  deps: LifecycleDeps,
  folder: vscode.WorkspaceFolder,
  uri: vscode.Uri,
  path: string,
  status: "pending" | "reviewed",
  maxSize: number,
): Promise<void> {
  const store = deps.storeForFolder(folder);
  if (store === undefined || !(await deps.isEligibleSource(uri))) {
    return;
  }
  let { bytes, source } = await readStableSource(uri, maxSize);
  let nextRevExtId = 1;
  if (status === "pending") {
    if (!(await deps.isEligibleSource(uri))) {
      return;
    }
    nextRevExtId = await deps.annotatePendingDocument(uri);
    ({ bytes, source } = await readStableSource(uri, maxSize));
  }
  const baseline = status === "reviewed" ? bytes : new Uint8Array();
  const file = await createRecord(
    deps.git,
    path,
    baseline,
    bytes,
    source,
    status === "reviewed" ? now() : undefined,
    status === "pending" ? initialAdditionHunks(bytes) : [],
  );
  if (!(await deps.isEligibleSource(uri))) {
    return;
  }
  await store.commit(path, { ...file, nextRevExtId }, baseline);
}
