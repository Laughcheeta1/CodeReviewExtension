import type * as vscode from "vscode";
import type { GitService } from "../../git";
import type { FileRecord } from "../../domain";
import type { PersistentStore } from "../../store";
import type { PreparedSource } from "../../source-io";
import type { RevExtAnnotationContext } from "../../revext-annotation";

/**
 * Explicit dependencies for workspace lifecycle operations. Every
 * initialization, reconciliation, and cleanup flow states exactly which
 * service capabilities it uses.
 */
export interface LifecycleDeps {
  readonly log: vscode.LogOutputChannel;
  readonly git: GitService;
  storeFor(uri: vscode.Uri): PersistentStore | undefined;
  storeForFolder(folder: vscode.WorkspaceFolder): PersistentStore | undefined;
  relativePath(uri: vscode.Uri): string | undefined;
  isEligibleSource(uri: vscode.Uri): Promise<boolean>;
  isTrackableUri(uri: vscode.Uri): boolean;
  maxSize(): number;
  isRevExtDisabled(uri: vscode.Uri): boolean;
  dirtyDocument(uri: vscode.Uri): vscode.TextDocument | undefined;
  withSource<T>(uri: vscode.Uri, operation: () => Promise<T>): Promise<T>;
  recompute(
    uri: vscode.Uri,
    forceDigest: boolean,
    createMissing?: boolean,
    prepared?: PreparedSource,
    previous?: FileRecord,
    rebuildPolicy?: boolean,
  ): Promise<boolean>;
  recomputeSavedDocument(document: vscode.TextDocument): Promise<boolean>;
  annotatePendingDocument(uri: vscode.Uri): Promise<number>;
  annotationContext(): RevExtAnnotationContext;
  consumeInternalSave(key: string): boolean;
  hideSources(uris: readonly vscode.Uri[]): void;
  refreshEligiblePaths(
    folder: vscode.WorkspaceFolder,
    force?: boolean,
  ): Promise<readonly string[] | undefined>;
  ensureIncludes(
    folder: vscode.WorkspaceFolder,
    path: string,
  ): Promise<boolean>;
  setEligiblePaths(
    folder: vscode.WorkspaceFolder,
    paths: readonly string[],
  ): void;
  trackedPaths(
    folder: vscode.WorkspaceFolder,
  ): ReadonlySet<string> | undefined;
  trackPath(folder: vscode.WorkspaceFolder, path: string): void;
  untrackPath(folder: vscode.WorkspaceFolder, path: string): boolean;
  tryBeginInitialization(folder: vscode.WorkspaceFolder): boolean;
  endInitialization(folder: vscode.WorkspaceFolder): void;
  drainSources(): Promise<void>;
  drainFolder(folder: vscode.WorkspaceFolder): Promise<void>;
  notifyChanged(uri?: vscode.Uri): void;
}

// Narrow structural interfaces aligned to actual responsibilities —
// `LifecycleDeps` structurally satisfies each. Reading cleanup deps should
// not imply access to annotation/promotion capabilities.
export interface InitializationDeps {
  readonly log: vscode.LogOutputChannel;
  readonly git: GitService;
  storeForFolder(folder: vscode.WorkspaceFolder): PersistentStore | undefined;
  relativePath(uri: vscode.Uri): string | undefined;
  isEligibleSource(uri: vscode.Uri): Promise<boolean>;
  maxSize(): number;
  isRevExtDisabled(uri: vscode.Uri): boolean;
  withSource<T>(uri: vscode.Uri, operation: () => Promise<T>): Promise<T>;
  recompute(uri: vscode.Uri, forceDigest: boolean, createMissing?: boolean, prepared?: PreparedSource, previous?: FileRecord, rebuildPolicy?: boolean): Promise<boolean>;
  annotatePendingDocument(uri: vscode.Uri): Promise<number>;
  tryBeginInitialization(folder: vscode.WorkspaceFolder): boolean;
  endInitialization(folder: vscode.WorkspaceFolder): void;
  drainFolder(folder: vscode.WorkspaceFolder): Promise<void>;
}

export interface ReconciliationDeps {
  readonly log: vscode.LogOutputChannel;
  storeForFolder(folder: vscode.WorkspaceFolder): PersistentStore | undefined;
  withSource<T>(uri: vscode.Uri, operation: () => Promise<T>): Promise<T>;
  recompute(uri: vscode.Uri, forceDigest: boolean, createMissing?: boolean): Promise<boolean>;
  recomputeSavedDocument(document: vscode.TextDocument): Promise<boolean>;
}

export interface CleanupDeps {
  readonly log: vscode.LogOutputChannel;
  storeForFolder(folder: vscode.WorkspaceFolder): PersistentStore | undefined;
  notifyChanged(uri?: vscode.Uri): void;
}
