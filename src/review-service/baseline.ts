import * as vscode from "vscode";
import type { FileRecord } from "../domain";
import type { PersistentStore } from "../store";
import type { BaselineIdentity } from "../review-mutations";

export const BASELINE_SCHEME = "code-review-baseline";

export interface BaselineDeps {
  storeFor(uri: vscode.Uri): PersistentStore | undefined;
  relativePath(uri: vscode.Uri): string | undefined;
  dirtyDocument(uri: vscode.Uri): vscode.TextDocument | undefined;
  withSource<T>(uri: vscode.Uri, operation: () => Promise<T>): Promise<T>;
  recompute(uri: vscode.Uri, forceDigest: boolean): Promise<boolean>;
  requireFresh(
    source: vscode.Uri,
    identity?: BaselineIdentity,
    forceDigest?: boolean,
  ): Promise<FileRecord>;
  initializeMissingSource(uri: vscode.Uri): Promise<boolean>;
  ensureIncludes(
    folder: vscode.WorkspaceFolder,
    path: string,
  ): Promise<boolean>;
  maxSize(): number;
}

export function baselineUri(
  source: vscode.Uri,
  file: FileRecord,
): vscode.Uri {
  return vscode.Uri.from({
    scheme: BASELINE_SCHEME,
    path: source.path,
    query: new URLSearchParams({
      source: source.toString(),
      baseline: file.baseline.digest,
      current: file.current.digest,
    }).toString(),
  });
}

export function parseBaselineUri(uri: vscode.Uri): BaselineIdentity | undefined {
  if (uri.scheme !== BASELINE_SCHEME) {
    return undefined;
  }
  const query = new URLSearchParams(uri.query);
  const source = query.get("source");
  const baselineDigest = query.get("baseline");
  const currentDigest = query.get("current");
  if (source === null || baselineDigest === null || currentDigest === null) {
    return undefined;
  }
  return {
    source: vscode.Uri.parse(source),
    baselineDigest,
    currentDigest,
  };
}

export function isBaselineUri(uri: vscode.Uri): boolean {
  return uri.scheme === BASELINE_SCHEME;
}

export async function baselineContent(
  deps: BaselineDeps,
  uri: vscode.Uri,
): Promise<string> {
  const identity = parseBaselineUri(uri);
  if (identity === undefined) {
    throw new Error("Invalid baseline URI");
  }
  return deps.withSource(identity.source, async () => {
    const file = await deps.requireFresh(identity.source, identity, false);
    const store = deps.storeFor(identity.source);
    if (store === undefined) {
      throw new Error("Baseline workspace is unavailable");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await store.loadBaseline(file, deps.maxSize()),
    );
  });
}

export async function prepareDiff(
  deps: BaselineDeps,
  source: vscode.Uri,
): Promise<{ baseline: vscode.Uri; file: FileRecord } | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(source);
  const path = deps.relativePath(source);
  if (folder === undefined || path === undefined) {
    return undefined;
  }
  if (!(await deps.ensureIncludes(folder, path))) {
    return undefined;
  }
  await deps.initializeMissingSource(source);
  return deps.withSource(source, async () => {
    if (deps.dirtyDocument(source) !== undefined) {
      throw new Error("Save the file before opening its review diff.");
    }
    await deps.recompute(source, false);
    const store = deps.storeFor(source);
    const file = await store?.load(path);
    return file === undefined
      ? undefined
      : { baseline: baselineUri(source, file), file };
  });
}
