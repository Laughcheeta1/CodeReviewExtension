import * as vscode from "vscode";
import {
  type FileRecord,
  type ReviewStatus,
  type Reviewer,
} from "./domain";
import { GitService } from "./git";
import { GitIgnoreService } from "./git-ignore";
import { PersistentStore } from "./store";
import type { TrackingTarget } from "./tracking";
import type { PreparedSource } from "./source-io";
import {
  annotatePendingDocument as annotatePendingSource,
  recomputeSavedDocument as recomputeSavedSource,
  type RevExtAnnotationContext,
} from "./revext-annotation";
import {
  applyReview as applyReviewMutation,
  initializePendingFile as initializePendingFileMutation,
  promote as promoteMutation,
  requireFresh as requireFreshMutation,
  type BaselineIdentity,
  type ReviewMutationContext,
} from "./review-mutations";
import {
  markEditor as markEditorAction,
  markFile as markFileAction,
  markFolder as markFolderAction,
  type ReviewActionContext,
} from "./review-actions";
import {
  EligibilityTracker,
  relativePath as workspaceRelativePath,
} from "./review-service/eligibility";
import { SourceGate } from "./review-service/gate";
import {
  ignoreEmptyLineDeletions as readIgnoreEmptyLineDeletions,
  isRevExtDisabled as readRevExtDisabled,
  maxFileSize,
} from "./review-service/config";
import { recomputeSource } from "./review-service/recompute";
import {
  cleanupIgnoredSources as cleanupIgnoredSourcesLifecycle,
  cleanupMissingSources as cleanupMissingSourcesLifecycle,
  initializeDiscoveredSources as initializeDiscoveredSourcesLifecycle,
  initializeFolder as initializeFolderLifecycle,
  initializeMissingSource as initializeMissingSourceLifecycle,
  initializeOpenedDocument as initializeOpenedDocumentLifecycle,
  initializeSource as initializeSourceLifecycle,
  reconcileCreatedSource as reconcileCreatedSourceLifecycle,
  reconcileExternalChanges as reconcileExternalChangesLifecycle,
  reconcileExternalSource as reconcileExternalSourceLifecycle,
  reconcileSavedDocument as reconcileSavedDocumentLifecycle,
  refreshReviewPolicy as refreshReviewPolicyLifecycle,
  type LifecycleDeps,
} from "./review-service/lifecycle";
import {
  baselineContent as baselineContentLifecycle,
  isBaselineUri,
  parseBaselineUri as parseBaselineUriLifecycle,
  prepareDiff as prepareDiffLifecycle,
  type BaselineDeps,
} from "./review-service/baseline";
export class ReviewService implements vscode.Disposable {
  private readonly stores = new Map<string, PersistentStore>();
  private readonly eligibility: EligibilityTracker;
  private readonly gate = new SourceGate();
  private readonly internalSaves = new Set<string>();
  private readonly internalDocumentLoads = new Set<string>();
  private readonly changedEmitter = new vscode.EventEmitter<
    vscode.Uri | undefined
  >();
  readonly onDidChange = this.changedEmitter.event;
  private readonly promotedEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidPromote = this.promotedEmitter.event;
  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly git: GitService,
    private readonly ignoreRules: GitIgnoreService,
  ) {
    this.eligibility = new EligibilityTracker(
      this.stores,
      this.ignoreRules,
      this.log,
      () => this.changedEmitter.fire(undefined),
    );
  }

  async initialize(): Promise<void> {
    await Promise.all((vscode.workspace.workspaceFolders ?? []).map(async (folder) => {
      const store = new PersistentStore(folder, this.log);
      await store.initialize();
      this.stores.set(folder.uri.toString(), store);
    }));
  }
  hasMetadata(folder: vscode.WorkspaceFolder): boolean {
    return this.stores.get(folder.uri.toString())?.hasMetadata ?? false;
  }
  initializationState(
    folder: vscode.WorkspaceFolder,
  ): "unconfigured" | "disabled" | "initialized" {
    return (
      this.stores.get(folder.uri.toString())?.initializationState ??
      "unconfigured"
    );
  }
  async disableInitialization(folder: vscode.WorkspaceFolder): Promise<void> {
    const store = this.stores.get(folder.uri.toString());
    if (store === undefined) {
      return;
    }
    await store.disableTracking();
    this.setEligiblePaths(folder, []);
  }

  dispose(): void {
    this.internalDocumentLoads.clear();
    this.changedEmitter.dispose();
    this.promotedEmitter.dispose();
  }
  setEligiblePaths(
    folder: vscode.WorkspaceFolder,
    paths: readonly string[],
  ): void {
    this.eligibility.setEligiblePaths(folder, paths);
  }
  relativePath(uri: vscode.Uri): string | undefined {
    return workspaceRelativePath(uri);
  }
  isTrackable(document: vscode.TextDocument): boolean {
    return this.isTrackableUri(document.uri);
  }
  isBaseline(uri: vscode.Uri): boolean {
    return isBaselineUri(uri);
  }
  file(uri: vscode.Uri): FileRecord | undefined {
    const source = this.isBaseline(uri)
      ? this.parseBaselineUri(uri)?.source
      : uri;
    if (source === undefined) {
      return undefined;
    }
    const path = this.relativePath(source);
    return path === undefined ? undefined : this.storeFor(source)?.peek(path);
  }
  status(uri: vscode.Uri): ReviewStatus | undefined {
    const path = this.relativePath(uri);
    const store = this.storeFor(uri);
    if (path === undefined || store === undefined) {
      return undefined;
    }
    return store.peek(path)?.fileStatus ?? store.summary(path)?.status;
  }
  async ensureDocument(document: vscode.TextDocument): Promise<void> {
    if (!this.isTrackable(document)) {
      return;
    }
    const path = this.relativePath(document.uri);
    const store = this.storeFor(document.uri);
    if (path === undefined || store === undefined || store.hasLoaded(path)) {
      return;
    }
    const key = document.uri.toString();
    await this.gate.ensureDocumentLoad(key, async () => {
      if (!(await this.isEligibleSource(document.uri))) {
        return;
      }
      try {
        await this.withSource(document.uri, async () => {
          if (store.hasLoaded(path)) {
            return;
          }
          await store.load(path);
          this.changedEmitter.fire(document.uri);
        });
      } catch {
        /* The store logged read failures; initialization intentionally blocks this load. */
      }
    });
  }
  async openDocumentForInternalUse(
    uri: vscode.Uri,
  ): Promise<vscode.TextDocument> {
    const key = uri.toString();
    const existing = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === key,
    );
    if (existing !== undefined) {
      if (
        !vscode.window.visibleTextEditors.some(
          (editor) => editor.document.uri.toString() === key,
        )
      ) {
        this.internalDocumentLoads.add(key);
      }
      return existing;
    }
    this.internalDocumentLoads.add(key);
    try {
      return await vscode.workspace.openTextDocument(uri);
    } catch (error) {
      this.internalDocumentLoads.delete(key);
      throw error;
    }
  }
  isInternalDocumentLoad(uri: vscode.Uri): boolean {
    return this.internalDocumentLoads.has(uri.toString());
  }
  consumeInternalDocumentLoad(uri: vscode.Uri): boolean {
    return this.internalDocumentLoads.delete(uri.toString());
  }
  forgetInternalDocumentLoad(uri: vscode.Uri): void {
    this.internalDocumentLoads.delete(uri.toString());
  }
  async initializeOpenedDocument(document: vscode.TextDocument): Promise<void> {
    await initializeOpenedDocumentLifecycle(
      this.lifecycleDeps(),
      document,
    );
  }
  async initializeSource(uri: vscode.Uri): Promise<void> {
    await initializeSourceLifecycle(this.lifecycleDeps(), uri);
  }
  async initializeDiscoveredSources(folder: vscode.WorkspaceFolder): Promise<void> {
    await initializeDiscoveredSourcesLifecycle(this.lifecycleDeps(), folder);
  }
  private async initializeMissingSource(uri: vscode.Uri): Promise<boolean> {
    return initializeMissingSourceLifecycle(this.lifecycleDeps(), uri);
  }
  async reconcileExternalChanges(
    folder: vscode.WorkspaceFolder,
    force = false,
  ): Promise<void> {
    await reconcileExternalChangesLifecycle(
      this.lifecycleDeps(),
      folder,
      force,
    );
  }
  async refreshReviewPolicy(): Promise<void> {
    await refreshReviewPolicyLifecycle(this.lifecycleDeps());
  }
  async cleanupMissingSources(folder: vscode.WorkspaceFolder): Promise<void> {
    await cleanupMissingSourcesLifecycle(this.lifecycleDeps(), folder);
  }
  async cleanupIgnoredSources(folder: vscode.WorkspaceFolder): Promise<void> {
    await cleanupIgnoredSourcesLifecycle(this.lifecycleDeps(), folder, (candidate, paths) =>
      this.ignoreRules.ignoredPaths(candidate, paths),
    );
  }
  async reconcileCreatedSource(uri: vscode.Uri): Promise<void> {
    await reconcileCreatedSourceLifecycle(this.lifecycleDeps(), uri);
  }
  async reconcileExternalSource(uri: vscode.Uri): Promise<void> {
    await reconcileExternalSourceLifecycle(this.lifecycleDeps(), uri);
  }
  async reconcileSavedDocument(document: vscode.TextDocument): Promise<void> {
    await reconcileSavedDocumentLifecycle(this.lifecycleDeps(), document);
  }
  async initializeFolder(
    folder: vscode.WorkspaceFolder,
    status: "pending" | "reviewed",
    targets?: readonly TrackingTarget[],
    candidatePaths?: readonly string[],
  ): Promise<void> {
    await initializeFolderLifecycle(
      this.lifecycleDeps(),
      folder,
      status,
      targets,
      candidatePaths,
    );
  }
  parseBaselineUri(uri: vscode.Uri): BaselineIdentity | undefined {
    return parseBaselineUriLifecycle(uri);
  }
  async baselineContent(uri: vscode.Uri): Promise<string> {
    return baselineContentLifecycle(this.baselineDeps(), uri);
  }
  async prepareDiff(source: vscode.Uri): Promise<
    | {
        baseline: vscode.Uri;
        file: FileRecord;
      }
    | undefined
  > {
    return prepareDiffLifecycle(this.baselineDeps(), source);
  }
  async markEditor(
    editor: vscode.TextEditor,
    status: ReviewStatus,
    reviewer?: Reviewer,
  ): Promise<boolean> {
    return markEditorAction(this.actionContext(), editor, status, reviewer);
  }
  async markFile(
    source: vscode.Uri,
    status: ReviewStatus,
    reviewer?: Reviewer,
  ): Promise<boolean> {
    return markFileAction(this.actionContext(), source, status, reviewer);
  }
  async markFolder(
    uri: vscode.Uri,
    status: ReviewStatus,
    reviewer?: Reviewer,
  ): Promise<number> {
    return markFolderAction(this.actionContext(), uri, status, reviewer);
  }
  private async initializePendingFile(source: vscode.Uri): Promise<boolean> {
    return initializePendingFileMutation(this.mutationContext(), source);
  }
  summary(folder?: vscode.WorkspaceFolder): readonly {
    uri: vscode.Uri;
    path: string;
    status: ReviewStatus;
    reviewed: number;
    total: number;
  }[] {
    const result: {
      uri: vscode.Uri;
      path: string;
      status: ReviewStatus;
      reviewed: number;
      total: number;
    }[] = [];
    for (const workspaceFolder of folder === undefined
      ? (vscode.workspace.workspaceFolders ?? [])
      : [folder]) {
      const store = this.stores.get(workspaceFolder.uri.toString());
      if (store === undefined) {
        continue;
      }
      const eligible = this.eligibility.trackedPaths(workspaceFolder);
      for (const path of store.paths) {
        if (eligible !== undefined && !eligible.has(path)) {
          continue;
        }
        const summary = store.summary(path);
        if (summary === undefined) {
          continue;
        }
        result.push({
          uri: vscode.Uri.joinPath(workspaceFolder.uri, ...path.split("/")),
          path,
          status: summary.status,
          reviewed: summary.reviewed,
          total: summary.total,
        });
      }
    }
    return result;
  }
  hideSources(uris: readonly vscode.Uri[]): void {
    let changed = false;
    for (const uri of uris) {
      const store = this.storeFor(uri);
      if (store === undefined || store.owns(uri)) {
        continue;
      }
      const path = this.relativePath(uri);
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (path === undefined || folder === undefined) {
        continue;
      }
      if (
        this.eligibility.untrackPath(
          folder,
          path,
        )
      ) {
        changed = true;
      }
    }
    if (changed) {
      this.changedEmitter.fire(undefined);
    }
  }
  private async recompute(
    uri: vscode.Uri,
    forceDigest: boolean,
    createMissing = false,
    prepared?: PreparedSource,
    previous?: FileRecord,
    rebuildPolicy = false,
  ): Promise<boolean> {
    return recomputeSource(
      {
        git: this.git,
        isEligibleSource: (candidate) => this.isEligibleSource(candidate),
        relativePath: (candidate) => this.relativePath(candidate),
        storeFor: (candidate) => this.storeFor(candidate),
        maxSize: () => this.maxSize(),
        ignoreEmptyLineDeletions: (candidate) =>
          this.ignoreEmptyLineDeletions(candidate),
        promoteFile: (candidate, file) =>
          promoteMutation(this.mutationContext(), candidate, file),
      },
      uri,
      forceDigest,
      createMissing,
      prepared,
      previous,
      rebuildPolicy,
    );
  }
  private async recomputeSavedDocument(
    document: vscode.TextDocument,
  ): Promise<boolean> {
    return recomputeSavedSource(this.annotationContext(), document);
  }
  private async annotatePendingDocument(uri: vscode.Uri): Promise<number> {
    return annotatePendingSource(this.annotationContext(), uri);
  }
  private annotationContext(): RevExtAnnotationContext {
    return {
      git: this.git,
      internalSaves: this.internalSaves,
      openDocumentForInternalUse: (uri) =>
        this.openDocumentForInternalUse(uri),
      maxSize: () => this.maxSize(),
      isEligibleSource: (uri) => this.isEligibleSource(uri),
      isRevExtDisabled: (uri) => this.isRevExtDisabled(uri),
      relativePath: (uri) => this.relativePath(uri),
      storeFor: (uri) => this.storeFor(uri),
      recompute: (
        uri,
        forceDigest,
        createMissing,
        prepared,
        previous,
      ) =>
        this.recompute(
          uri,
          forceDigest,
          createMissing,
          prepared,
          previous,
        ),
    };
  }
  private async requireFresh(
    source: vscode.Uri,
    identity?: BaselineIdentity,
    forceDigest = true,
  ): Promise<FileRecord> {
    return requireFreshMutation(
      this.mutationContext(),
      source,
      identity,
      forceDigest,
    );
  }
  private async applyReview(
    source: vscode.Uri,
    file: FileRecord,
    status: ReviewStatus,
    reviewer: Reviewer | undefined,
    matchesCurrent: (line: FileRecord["currentLines"][number]) => boolean,
    matchesDeleted: (line: FileRecord["deletedLines"][number]) => boolean,
  ): Promise<boolean> {
    return applyReviewMutation(
      this.mutationContext(),
      source,
      file,
      status,
      reviewer,
      matchesCurrent,
      matchesDeleted,
    );
  }
  private actionContext(): ReviewActionContext {
    return {
      parseBaselineUri: (uri) => this.parseBaselineUri(uri),
      isEligibleSource: (uri) => this.isEligibleSource(uri),
      initializeMissingSource: (uri) => this.initializeMissingSource(uri),
      withSource: (uri, operation) => this.withSource(uri, operation),
      dirtyDocument: (uri) => this.dirtyDocument(uri),
      requireFresh: (uri, identity) => this.requireFresh(uri, identity),
      applyReview: (
        source,
        file,
        status,
        reviewer,
        matchesCurrent,
        matchesDeleted,
      ) =>
        this.applyReview(
          source,
          file,
          status,
          reviewer,
          matchesCurrent,
          matchesDeleted,
        ),
      initializePendingFile: (uri) => this.initializePendingFile(uri),
      storeFor: (uri) => this.storeFor(uri),
      refreshEligiblePaths: (folder, force) =>
        this.refreshEligiblePaths(folder, force),
    };
  }
  private mutationContext(): ReviewMutationContext {
    return {
      git: this.git,
      internalSaves: this.internalSaves,
      openDocumentForInternalUse: (uri) =>
        this.openDocumentForInternalUse(uri),
      changedEmitter: this.changedEmitter,
      promotedEmitter: this.promotedEmitter,
      relativePath: (uri) => this.relativePath(uri),
      storeFor: (uri) => this.storeFor(uri),
      maxSize: () => this.maxSize(),
      isEligibleSource: (uri) => this.isEligibleSource(uri),
      isTrackableUri: (uri) => this.isTrackableUri(uri),
      recompute: (uri, forceDigest, createMissing) =>
        this.recompute(uri, forceDigest, createMissing),
      annotatePendingDocument: (uri) => this.annotatePendingDocument(uri),
    };
  }
  private storeFor(uri: vscode.Uri): PersistentStore | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder === undefined
      ? undefined
      : this.stores.get(folder.uri.toString());
  }
  private storeForFolder(
    folder: vscode.WorkspaceFolder,
  ): PersistentStore | undefined {
    return this.stores.get(folder.uri.toString());
  }
  private lifecycleDeps(): LifecycleDeps {
    return {
      log: this.log,
      git: this.git,
      storeFor: (uri) => this.storeFor(uri),
      storeForFolder: (folder) => this.storeForFolder(folder),
      relativePath: (uri) => this.relativePath(uri),
      isEligibleSource: (uri) => this.isEligibleSource(uri),
      isTrackableUri: (uri) => this.isTrackableUri(uri),
      maxSize: () => this.maxSize(),
      isRevExtDisabled: (uri) => this.isRevExtDisabled(uri),
      dirtyDocument: (uri) => this.dirtyDocument(uri),
      withSource: (uri, operation) => this.withSource(uri, operation),
      recompute: (
        uri,
        forceDigest,
        createMissing,
        prepared,
        previous,
        rebuildPolicy,
      ) =>
        this.recompute(
          uri,
          forceDigest,
          createMissing,
          prepared,
          previous,
          rebuildPolicy,
        ),
      recomputeSavedDocument: (document) =>
        this.recomputeSavedDocument(document),
      annotatePendingDocument: (uri) => this.annotatePendingDocument(uri),
      annotationContext: () => this.annotationContext(),
      consumeInternalSave: (key) => this.internalSaves.delete(key),
      hideSources: (uris) => this.hideSources(uris),
      refreshEligiblePaths: (folder, force) =>
        this.refreshEligiblePaths(folder, force),
      ensureIncludes: (folder, path) =>
        this.eligibility.ensureIncludes(folder, path),
      setEligiblePaths: (folder, paths) =>
        this.setEligiblePaths(folder, paths),
      trackedPaths: (folder) => this.eligibility.trackedPaths(folder),
      trackPath: (folder, path) => this.eligibility.trackPath(folder, path),
      untrackPath: (folder, path) =>
        this.eligibility.untrackPath(folder, path),
      tryBeginInitialization: (folder) =>
        this.gate.tryBeginInitialization(folder),
      endInitialization: (folder) => this.gate.endInitialization(folder),
      drainSources: () => this.gate.drainSources(),
      notifyChanged: (uri) => this.changedEmitter.fire(uri),
    };
  }
  private baselineDeps(): BaselineDeps {
    return {
      storeFor: (uri) => this.storeFor(uri),
      relativePath: (uri) => this.relativePath(uri),
      dirtyDocument: (uri) => this.dirtyDocument(uri),
      withSource: (uri, operation) => this.withSource(uri, operation),
      recompute: (uri, forceDigest) => this.recompute(uri, forceDigest),
      requireFresh: (source, identity, forceDigest) =>
        this.requireFresh(source, identity, forceDigest),
      initializeMissingSource: (uri) => this.initializeMissingSource(uri),
      ensureIncludes: (folder, path) =>
        this.eligibility.ensureIncludes(folder, path),
      maxSize: () => this.maxSize(),
    };
  }
  private async refreshEligiblePaths(
    folder: vscode.WorkspaceFolder,
    force = false,
  ): Promise<readonly string[] | undefined> {
    return this.eligibility.refreshEligiblePaths(folder, force);
  }
  private async isEligibleSource(uri: vscode.Uri): Promise<boolean> {
    return this.eligibility.isEligibleSource(uri);
  }
  private isTrackableUri(uri: vscode.Uri): boolean {
    return this.eligibility.isTrackableUri(uri);
  }
  private dirtyDocument(source: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (document) =>
        document.uri.toString() === source.toString() && document.isDirty,
    );
  }
  private maxSize(): number {
    return maxFileSize();
  }
  private ignoreEmptyLineDeletions(uri: vscode.Uri): boolean {
    return readIgnoreEmptyLineDeletions(uri);
  }
  private isRevExtDisabled(uri: vscode.Uri): boolean {
    return readRevExtDisabled(uri);
  }
  private async withSource<T>(
    uri: vscode.Uri,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.gate.withSource(uri, operation);
  }
}



