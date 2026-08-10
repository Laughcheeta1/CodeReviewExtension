import * as vscode from "vscode";
import {
  buildDiffRecords,
  digestBytes,
  type FileRecord,
  type ReviewStatus,
  type Reviewer,
} from "./domain";
import { GitService } from "./git";
import { GitIgnoreService } from "./git-ignore";
import { PersistentStore } from "./store";
import { sourceMayHaveChanged } from "./storage-format";
import { tracksPath, type TrackingTarget } from "./tracking";
import {
  initialAdditionHunks,
  isExcludedPath,
  isFileNotFound,
  now,
  progressIncrement,
} from "./review-service-utils";
import { eligibleWorkspacePaths } from "./workspace-discovery";
import {
  createRecord,
  diffWithProgress,
  readStableSource,
  type PreparedSource,
} from "./source-io";
import {
  annotatePendingDocument as annotatePendingSource,
  recomputeExternalSource as recomputeExternalSourceWithAnnotations,
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
import { errorMessage } from "./extension-utils";
// RevExt: 436
const BASELINE_SCHEME = "code-review-baseline";
export class ReviewService implements vscode.Disposable {
  private readonly stores = new Map<string, PersistentStore>();
  private readonly eligiblePaths = new Map<string, Set<string>>();
  private readonly discoveredPaths = new Map<string, readonly string[]>();
  private readonly eligibilityRefreshes = new Map<
    string,
    Promise<readonly string[] | undefined>
  >();
  private readonly sourceTails = new Map<string, Promise<void>>();
  private readonly ensureTails = new Map<string, Promise<void>>();
  private readonly initializingFolders = new Set<string>();
  private readonly internalSaves = new Set<string>();
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
  ) {}
// RevExt: 2
  async initialize(): Promise<void> {
    await Promise.all((vscode.workspace.workspaceFolders ?? []).map(async (folder) => {
      const store = new PersistentStore(folder, this.log);
      await store.initialize();
      this.stores.set(folder.uri.toString(), store);
    }));  // RevExt: 12
  }  // RevExt: 73
  hasMetadata(folder: vscode.WorkspaceFolder): boolean {
    return this.stores.get(folder.uri.toString())?.hasMetadata ?? false;
  }  // RevExt: 74
  initializationState(
    folder: vscode.WorkspaceFolder,  // RevExt: 444
  ): "unconfigured" | "disabled" | "initialized" {
    return (  // RevExt: 445
      this.stores.get(folder.uri.toString())?.initializationState ??
      "unconfigured"
    );  // RevExt: 446
  }  // RevExt: 442
  async disableInitialization(folder: vscode.WorkspaceFolder): Promise<void> {
    const store = this.stores.get(folder.uri.toString());  // RevExt: 448
    if (store === undefined) {  // RevExt: 449
      return;  // RevExt: 450
    }  // RevExt: 439
    await store.disableTracking();
    this.setEligiblePaths(folder, []);
  }  // RevExt: 443
// RevExt: 3
  dispose(): void {
    this.changedEmitter.dispose();
    this.promotedEmitter.dispose();
  }  // RevExt: 75
  setEligiblePaths(
    folder: vscode.WorkspaceFolder,  // RevExt: 111
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
    if (  // RevExt: 114
      previous === undefined ||
      previous.size !== next.size ||
      [...previous].some((path) => !next.has(path))
    ) {  // RevExt: 121
      this.changedEmitter.fire(undefined);  // RevExt: 128
    }  // RevExt: 13
  }  // RevExt: 76
  relativePath(uri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);  // RevExt: 132
    return folder === undefined  // RevExt: 138
      ? undefined  // RevExt: 140
      : vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/");
  }  // RevExt: 77
  isTrackable(document: vscode.TextDocument): boolean {
    return this.isTrackableUri(document.uri);
  }  // RevExt: 78
  isBaseline(uri: vscode.Uri): boolean {
    return uri.scheme === BASELINE_SCHEME;
  }  // RevExt: 79
  file(uri: vscode.Uri): FileRecord | undefined {
    const source = this.isBaseline(uri)
      ? this.parseBaselineUri(uri)?.source
      : uri;
    if (source === undefined) {
      return undefined;  // RevExt: 142
    }  // RevExt: 14
    const path = this.relativePath(source);  // RevExt: 146
    return path === undefined ? undefined : this.storeFor(source)?.peek(path);
  }  // RevExt: 80
  status(uri: vscode.Uri): ReviewStatus | undefined {
    const path = this.relativePath(uri);  // RevExt: 150
    const store = this.storeFor(uri);  // RevExt: 154
    if (path === undefined || store === undefined) {  // RevExt: 157
      return undefined;  // RevExt: 143
    }  // RevExt: 15
    return store.peek(path)?.fileStatus ?? store.summary(path)?.status;
  }  // RevExt: 81
  async ensureDocument(document: vscode.TextDocument): Promise<void> {
    if (!this.isTrackable(document)) {
      return;  // RevExt: 162
    }  // RevExt: 16
    const path = this.relativePath(document.uri);  // RevExt: 175
    const store = this.storeFor(document.uri);  // RevExt: 178
    if (path === undefined || store === undefined || store.hasLoaded(path)) {
      return;  // RevExt: 163
    }  // RevExt: 17
    const key = document.uri.toString();
    const previous = this.ensureTails.get(key);
    if (previous !== undefined) {
      await previous;
      return;
    }
    const current = (async (): Promise<void> => {
      if (!(await this.isEligibleSource(document.uri))) {
        return;
      }
      try {  // RevExt: 181
        await this.withSource(document.uri, async () => {
          if (store.hasLoaded(path)) {
            return;
          }  // RevExt: 187
          await store.load(path);
          this.changedEmitter.fire(document.uri);
        });  // RevExt: 192
      } catch {
        /* The store logged read failures; initialization intentionally blocks this load. */
      }
    })();
    this.ensureTails.set(key, current);
    try {
      await current;
    } finally {
      if (this.ensureTails.get(key) === current) {
        this.ensureTails.delete(key);
      }
    }
  }  // RevExt: 82
  async initializeOpenedDocument(document: vscode.TextDocument): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder === undefined) {
      return;
    }
    if (this.initializationState(folder) !== "initialized") {
      return;
    }
    await this.refreshEligiblePaths(folder);
    if (document.isDirty) {
      return;
    }
    await this.initializeMissingSource(document.uri);
  }
  async initializeSource(uri: vscode.Uri): Promise<void> {
    await this.initializeMissingSource(uri);
  }
  async initializeDiscoveredSources(folder: vscode.WorkspaceFolder): Promise<void> {
    const store = this.stores.get(folder.uri.toString());
    if (store === undefined || store.initializationState !== "initialized") {
      return;
    }
    const eligible = await this.refreshEligiblePaths(folder);
    if (eligible === undefined) {
      return;
    }
    await store.includeTrackingTargets(
      eligible.map((path) => ({ kind: "file" as const, path })),
    );
    this.setEligiblePaths(folder, eligible);
    const paths = eligible.filter((path) => store.summary(path) === undefined);
    let initialized = 0;
    for (const path of paths) {
      const uri = vscode.Uri.joinPath(folder.uri, ...path.split("/"));
      if (await this.withSource(uri, () => this.recompute(uri, false, true))) {
        initialized += 1;
      }
    }
    if (initialized > 0) {
      this.log.info(
        `Initialized review metadata for ${initialized} discovered files at startup.`,
      );
      this.changedEmitter.fire(undefined);
    }
  }
  private async initializeMissingSource(uri: vscode.Uri): Promise<boolean> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder === undefined) {
      return false;
    }
    const path = this.relativePath(uri);
    const store = this.storeFor(uri);
    if (
      path === undefined ||
      store === undefined ||
      store.initializationState !== "initialized"
    ) {
      return false;
    }
    let eligible = await this.refreshEligiblePaths(folder);
    if (eligible !== undefined && !eligible.includes(path)) {
      eligible = await this.refreshEligiblePaths(folder, true);
    }
    if (eligible === undefined || !eligible.includes(path)) {
      return false;
    }
    if (this.dirtyDocument(uri) !== undefined) {
      return false;
    }
    await store.includeTrackingTarget({ kind: "file", path });
    this.setEligiblePaths(folder, eligible);
    if (!this.isTrackableUri(uri)) {
      return false;
    }
    const initialized = await this.withSource(uri, () =>
      this.recompute(uri, false, true),
    );
    if (initialized) {
      this.log.info(`Initialized review metadata for opened file ${path}.`);
      this.changedEmitter.fire(uri);
    }
    return initialized;
  }
  async reconcileExternalChanges(
    folder: vscode.WorkspaceFolder,  // RevExt: 112
    force = false,
  ): Promise<void> {  // RevExt: 196
    const store = this.stores.get(folder.uri.toString());  // RevExt: 201
    if (store === undefined) {  // RevExt: 204
      return;  // RevExt: 164
    }  // RevExt: 19
    if (store.initializationState !== "initialized") {
      return;  // RevExt: 451
    }  // RevExt: 440
    const eligible = this.eligiblePaths.get(folder.uri.toString());  // RevExt: 206
    let changed = 0;
    let hidden = 0;
    const paths = new Set(eligible ?? []);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Code Review: updating files",
      },  // RevExt: 452
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
            try {  // RevExt: 237
              if (
                await this.withSource(uri, () => this.recompute(uri, force, true))
              ) {
                changed += 1;
              }  // RevExt: 188
            } catch (error) {
              if (!isFileNotFound(error)) {
                this.log.warn(
                  `Review recomputation failed for ${path}; existing state was preserved: ${String(error)}`,
                );  // RevExt: 455
              } else {
                if (eligible?.delete(path)) {
                  hidden += 1;
                }
              }  // RevExt: 189
            } finally {
              completed += 1;
              progress.report({
                increment: progressIncrement(paths.size),
                message: `${completed}/${paths.size}`,
              });
            }  // RevExt: 214
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(4, pathList.length) },
            () => worker(),
          ),
        );
      },  // RevExt: 453
    );  // RevExt: 447
    if (changed > 0 || hidden > 0) {
      this.log.info(
        `Review reconciliation updated ${changed} and hid ${hidden} missing files.`,
      );  // RevExt: 241
      this.changedEmitter.fire(undefined);  // RevExt: 129
    }  // RevExt: 22
  }  // RevExt: 83
  async refreshReviewPolicy(): Promise<void> {
    let changed = false;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const store = this.stores.get(folder.uri.toString());
      if (
        store === undefined ||
        store.initializationState !== "initialized"
      ) {
        continue;
      }
      const eligible = await this.refreshEligiblePaths(folder);
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
            await this.withSource(uri, () =>
              this.recompute(uri, true, false, undefined, undefined, true),
            )
          ) {
            changed = true;
          }
        } catch (error) {
          this.log.warn(
            `Could not refresh review policy for ${path}: ${String(error)}`,
          );
        }
      }
    }
    if (changed) {
      this.changedEmitter.fire(undefined);
    }
  }
  async cleanupMissingSources(folder: vscode.WorkspaceFolder): Promise<void> {
    const store = this.stores.get(folder.uri.toString());
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
          this.log.warn(
            `Could not check whether ${path} still exists: ${String(error)}`,
          );
          continue;
        }
      }
      await store.delete(path);
      removed += 1;
    }
    if (removed > 0) {
      this.log.info(`Removed metadata for ${removed} missing files at startup.`);
      this.changedEmitter.fire(undefined);
    }
  }
  async cleanupIgnoredSources(folder: vscode.WorkspaceFolder): Promise<void> {
    const store = this.stores.get(folder.uri.toString());
    if (store === undefined || store.paths.length === 0) {
      return;
    }
    let ignored: ReadonlySet<string>;
    try {
      ignored = await this.ignoreRules.ignoredPaths(folder, store.paths);
    } catch (error) {
      this.log.warn(
        `Could not evaluate ignored sources; existing metadata was preserved: ${String(error)}`,
      );
      return;
    }
    for (const path of ignored) {
      await store.delete(path);
    }
    if (ignored.size > 0) {
      this.log.info(`Removed metadata for ${ignored.size} ignored files.`);
      this.changedEmitter.fire(undefined);
    }
  }
  async reconcileCreatedSource(uri: vscode.Uri): Promise<void> {
    const path = this.relativePath(uri);  // RevExt: 151
    const store = this.storeFor(uri);  // RevExt: 155
    const folder = vscode.workspace.getWorkspaceFolder(uri);  // RevExt: 133
    if (  // RevExt: 115
      path === undefined ||  // RevExt: 251
      store === undefined ||  // RevExt: 253
      folder === undefined ||
      store.initializationState !== "initialized" ||
      store.owns(uri) ||
      isExcludedPath(path)
    ) {  // RevExt: 122
      return;  // RevExt: 165
    }  // RevExt: 23
    const eligible = await this.refreshEligiblePaths(folder, true);
    if (eligible === undefined || !eligible.includes(path)) {
      return;
    }
    if (!(await this.initializeMissingSource(uri))) {
      return;
    }
    this.eligiblePaths.get(folder.uri.toString())?.add(path);
    this.changedEmitter.fire(uri);
  }  // RevExt: 84
  async reconcileExternalSource(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== "file") {
      return;
    }
    const path = this.relativePath(uri);
    const store = this.storeFor(uri);
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
    const eligible = await this.refreshEligiblePaths(folder, true);
    if (
      eligible === undefined ||
      !eligible.includes(path) ||
      !store.tracksPath(path)
    ) {
      return;
    }
    try {
      const changed = await this.withSource(uri, () =>
        recomputeExternalSourceWithAnnotations(this.annotationContext(), uri),
      );
      if (changed) {
        this.changedEmitter.fire(uri);
      }
    } catch (error) {
      if (isFileNotFound(error)) {
        this.hideSources([uri]);
        return;
      }
      this.log.warn(
        `Could not reconcile externally changed source ${path}: ${String(error)}`,
      );
    }
  }
  async reconcileSavedDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== "file") {
      return;  // RevExt: 167
    }  // RevExt: 26
    const internalKey = document.uri.toString();
    if (this.internalSaves.delete(internalKey)) {
      return;  // RevExt: 168
    }  // RevExt: 27
    const store = this.storeFor(document.uri);  // RevExt: 179
    const path = this.relativePath(document.uri);  // RevExt: 176
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (  // RevExt: 116
      store === undefined ||  // RevExt: 254
      path === undefined ||  // RevExt: 252
      folder === undefined ||
      store.initializationState !== "initialized"
    ) {  // RevExt: 123
      return;  // RevExt: 169
    }  // RevExt: 28
    let eligible = await this.refreshEligiblePaths(folder);
    if (eligible !== undefined && !eligible.includes(path)) {
      eligible = await this.refreshEligiblePaths(folder, true);
    }
    if (eligible === undefined || !eligible.includes(path)) {
      return;
    }
    if (!store.tracksPath(path)) {
      await this.initializeMissingSource(document.uri);
    }
    if (!store.tracksPath(path)) {
      return;
    }
    this.eligiblePaths
      .get(folder.uri.toString())
      ?.add(path);
    try {  // RevExt: 182
      await this.withSource(document.uri, () =>
        this.recomputeSavedDocument(document),
      );  // RevExt: 242
      this.changedEmitter.fire(document.uri);
    } catch (error) {
      this.log.warn(
        `Could not reconcile saved source ${this.relativePath(document.uri) ?? document.uri.toString()}: ${String(error)}`,
      );  // RevExt: 243
    }  // RevExt: 29
  }  // RevExt: 85
  async initializeFolder(
    folder: vscode.WorkspaceFolder,  // RevExt: 113
    status: "pending" | "reviewed",
    targets?: readonly TrackingTarget[],
    candidatePaths?: readonly string[],
  ): Promise<void> {  // RevExt: 197
    const store = this.stores.get(folder.uri.toString());  // RevExt: 202
    if (store === undefined) {  // RevExt: 205
      return;  // RevExt: 170
    }  // RevExt: 30
    const eligible = candidatePaths ?? this.eligiblePaths.get(folder.uri.toString());  // RevExt: 207
    if (eligible === undefined) {
      throw new Error("Workspace files have not been enumerated.");
    }  // RevExt: 31
    const configuredTargets = targets ?? store.trackingTargets();
    if (configuredTargets === undefined) {
      throw new Error("Choose files or folders before initializing review tracking.");
    }  // RevExt: 441
    const folderKey = folder.uri.toString();
    if (this.initializingFolders.has(folderKey)) {
      throw new Error("This workspace is already being initialized.");
    }  // RevExt: 32
    this.initializingFolders.add(folderKey);
    try {  // RevExt: 183
      await Promise.allSettled(this.sourceTails.values());
      await store.reset();
      const maxSize = this.maxSize();
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
        },  // RevExt: 257
        async (progress) => {
          let completed = 0;
          progress.report({ message: `0/${paths.length}` });
          for (let index = 0; index < paths.length; index += 1) {
            const path = paths[index]!;
            const uri = vscode.Uri.joinPath(folder.uri, ...path.split("/"));
            try {
              if (!(await this.isEligibleSource(uri))) {
                continue;
              }  // RevExt: 259
              let { bytes, source } = await readStableSource(
                uri,
                maxSize,
              );  // RevExt: 261
              let nextRevExtId = 1;
              if (status === "pending") {
                if (!(await this.isEligibleSource(uri))) {
                  continue;
                }
                nextRevExtId = await this.annotatePendingDocument(uri);
                ({ bytes, source } = await readStableSource(uri, maxSize));
              }  // RevExt: 260
              const baseline = status === "reviewed" ? bytes : new Uint8Array();
              const file = await createRecord(
                this.git,
                path,
                baseline,
                bytes,
                source,
                status === "reviewed" ? now() : undefined,
                status === "pending" ? initialAdditionHunks(bytes) : [],
              );  // RevExt: 262
              if (!(await this.isEligibleSource(uri))) {
                continue;
              }
              await store.commit(path, { ...file, nextRevExtId }, baseline);
            } catch (error) {
              this.log.warn(`Skipping ${path}: ${String(error)}`);
            } finally {
              completed += 1;
              progress.report({
                increment: progressIncrement(paths.length),
                message: `${completed}/${paths.length}`,
              });
            }  // RevExt: 454
          }  // RevExt: 456
        },  // RevExt: 258
      );  // RevExt: 244
      await store.enableTracking(configuredTargets);
      this.setEligiblePaths(folder, paths);
      this.changedEmitter.fire(undefined);  // RevExt: 130
    } finally {  // RevExt: 263
      this.initializingFolders.delete(folderKey);
    }  // RevExt: 33
  }  // RevExt: 86
  baselineUri(source: vscode.Uri, file: FileRecord): vscode.Uri {
    return vscode.Uri.from({
      scheme: BASELINE_SCHEME,
      path: source.path,
      query: new URLSearchParams({
        source: source.toString(),
        baseline: file.baseline.digest,
        current: file.current.digest,
      }).toString(),
    });  // RevExt: 267
  }  // RevExt: 87
  parseBaselineUri(uri: vscode.Uri): BaselineIdentity | undefined {
    if (!this.isBaseline(uri)) {
      return undefined;  // RevExt: 144
    }  // RevExt: 34
    const query = new URLSearchParams(uri.query);
    const source = query.get("source");
    const baselineDigest = query.get("baseline");
    const currentDigest = query.get("current");
    if (source === null || baselineDigest === null || currentDigest === null) {
      return undefined;  // RevExt: 145
    }  // RevExt: 35
    return {  // RevExt: 274
      source: vscode.Uri.parse(source),
      baselineDigest,
      currentDigest,
    };  // RevExt: 276
  }  // RevExt: 88
  async baselineContent(uri: vscode.Uri): Promise<string> {
    const identity = this.parseBaselineUri(uri);
    if (identity === undefined) {
      throw new Error("Invalid baseline URI");
    }  // RevExt: 36
    return this.withSource(identity.source, async () => {
      const file = await this.requireFresh(identity.source, identity, false);
      const store = this.storeFor(identity.source);
      if (store === undefined) {  // RevExt: 278
        throw new Error("Baseline workspace is unavailable");
      }  // RevExt: 215
      return new TextDecoder("utf-8", { fatal: true }).decode(
        await store.loadBaseline(file, this.maxSize()),
      );  // RevExt: 245
    });  // RevExt: 268
  }  // RevExt: 89
  async prepareDiff(source: vscode.Uri): Promise<
    | {
        baseline: vscode.Uri;
        file: FileRecord;
      }  // RevExt: 216
    | undefined
  > {
    const folder = vscode.workspace.getWorkspaceFolder(source);
    const path = this.relativePath(source);
    if (folder === undefined || path === undefined) {
      return undefined;
    }
    let eligible = await this.refreshEligiblePaths(folder);
    if (eligible !== undefined && !eligible.includes(path)) {
      eligible = await this.refreshEligiblePaths(folder, true);
    }
    if (eligible === undefined || !eligible.includes(path)) {
      return undefined;
    }
    await this.initializeMissingSource(source);
    return this.withSource(source, async () => {  // RevExt: 280
      if (this.dirtyDocument(source) !== undefined) {  // RevExt: 282
        throw new Error("Save the file before opening its review diff.");
      }  // RevExt: 217
      await this.recompute(source, false);  // RevExt: 285
      const store = this.storeFor(source);
      const file = await store?.load(path);
      return file === undefined
        ? undefined
        : { baseline: this.baselineUri(source, file), file };
    });  // RevExt: 269
  }  // RevExt: 90
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
      if (store === undefined) {  // RevExt: 279
        continue;  // RevExt: 209
      }  // RevExt: 221
      const eligible = this.eligiblePaths.get(workspaceFolder.uri.toString());
      for (const path of store.paths) {
        if (eligible !== undefined && !eligible.has(path)) {
          continue;
        }
        const summary = store.summary(path);
        if (summary === undefined) {
          continue;  // RevExt: 240
        }  // RevExt: 190
        result.push({
          uri: vscode.Uri.joinPath(workspaceFolder.uri, ...path.split("/")),
          path,
          status: summary.status,
          reviewed: summary.reviewed,
          total: summary.total,
        });
      }  // RevExt: 222
    }  // RevExt: 37
    return result;
  }  // RevExt: 93
  hideSources(uris: readonly vscode.Uri[]): void {
    let changed = false;
    for (const uri of uris) {
      const store = this.storeFor(uri);
      if (store === undefined || store.owns(uri)) {
        continue;  // RevExt: 210
      }  // RevExt: 223
      const path = this.relativePath(uri);
      if (path === undefined) {
        continue;  // RevExt: 211
      }  // RevExt: 224
      if (
        this.eligiblePaths  // RevExt: 315
          .get(vscode.workspace.getWorkspaceFolder(uri)!.uri.toString())
          ?.delete(path)
      ) {
        changed = true;
      }
    }  // RevExt: 38
    if (changed) {
      this.changedEmitter.fire(undefined);  // RevExt: 131
    }  // RevExt: 39
  }  // RevExt: 94
  private async recompute(
    uri: vscode.Uri,  // RevExt: 317
    forceDigest: boolean,
    createMissing = false,
    prepared?: PreparedSource,
    previous?: FileRecord,
    rebuildPolicy = false,
  ): Promise<boolean> {  // RevExt: 293
    // Re-check the current ignore-rule snapshot at the final recomputation
    // boundary. All callers also perform an eligibility check, but this guard
    // prevents a stale lifecycle decision from creating metadata.
    if (!(await this.isEligibleSource(uri))) {
      return false;
    }
    const path = this.relativePath(uri);  // RevExt: 152
    const store = this.storeFor(uri);  // RevExt: 156
    if (path === undefined || store === undefined) {  // RevExt: 158
      return false;  // RevExt: 320
    }  // RevExt: 40
    const existing = previous ?? (await store.load(path));  // RevExt: 328
    if (existing === undefined) {  // RevExt: 330
      if (!createMissing) {
        return false;  // RevExt: 332
      }  // RevExt: 225
      const { bytes, source } = await readStableSource(
        uri,
        this.maxSize(),  // RevExt: 334
      );  // RevExt: 248
      const baseline = new Uint8Array();
      if (!(await this.isEligibleSource(uri))) {
        return false;
      }
      await store.commit(
        path,
        await createRecord(
          this.git,
          path,
          baseline,
          bytes,
          source,
          undefined,
          initialAdditionHunks(bytes),
        ),
        baseline,
      );  // RevExt: 249
      return true;  // RevExt: 336
    }  // RevExt: 41
    let initialStat: vscode.FileStat | undefined;
    if (prepared === undefined) {
      initialStat = await vscode.workspace.fs.stat(uri);  // RevExt: 256
      if (
        !forceDigest &&
        !sourceMayHaveChanged(
          initialStat.mtime,
          initialStat.size,
          existing.current,
        )
      ) {  // RevExt: 124
        return false;  // RevExt: 321
      }
    }  // RevExt: 42
    const { bytes, source } =
      prepared ?? (await readStableSource(uri, this.maxSize(), initialStat));
    const digest = digestBytes(bytes);
    const policyNeedsRebuild =
      rebuildPolicy && existing.baseline.digest !== existing.current.digest;
    if (digest === existing.current.digest && !policyNeedsRebuild) {
      if (  // RevExt: 338
        source.modifiedAt === existing.current.modifiedAt &&
        source.size === existing.current.size
      ) {  // RevExt: 340
        return false;  // RevExt: 333
      }  // RevExt: 226
      if (!(await this.isEligibleSource(uri))) {
        return false;
      }
      await store.commit(path, {  // RevExt: 343
        ...existing,
        current: { ...existing.current, ...source },
        updatedAt: now(),  // RevExt: 345
      });  // RevExt: 194
      return true;  // RevExt: 337
    }  // RevExt: 43
    const baseline = await store.loadBaseline(existing, this.maxSize());  // RevExt: 347
    const rawHunks =
      prepared?.rawHunks ??
      (await diffWithProgress(
        this.git,
        baseline,
        bytes,
        this.relativePath(uri) ?? uri.fsPath,
      ));
    const ignoreEmptyLineDeletions = this.ignoreEmptyLineDeletions(uri);
    const diff = buildDiffRecords(
      baseline,
      bytes,
      rawHunks,
      existing,
      { ignoreEmptyLineDeletions },
    );
    if (!(await this.isEligibleSource(uri))) {
      return false;
    }
    const nextFile: FileRecord = {
      ...existing,
      ...diff,  // RevExt: 349
      current: {  // RevExt: 351
        digest,
        ...source,  // RevExt: 353
        gitAlgorithm: "myers",  // RevExt: 355
        generatedAt: now(),
      },  // RevExt: 357
      updatedAt: now(),
    };
    if (
      ignoreEmptyLineDeletions &&
      existing.baseline.digest !== digest &&
      diff.hunks.length === 0
    ) {
      await promoteMutation(this.mutationContext(), uri, nextFile);
      return true;
    }
    await store.commit(path, nextFile);  // RevExt: 272
    return true;  // RevExt: 360
  }  // RevExt: 95
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
      maxSize: () => this.maxSize(),
      isEligibleSource: (uri) => this.isEligibleSource(uri),
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
    const folder = vscode.workspace.getWorkspaceFolder(uri);  // RevExt: 134
    return folder === undefined  // RevExt: 139
      ? undefined  // RevExt: 141
      : this.stores.get(folder.uri.toString());
  }  // RevExt: 103
  private async refreshEligiblePaths(
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
    const active = this.eligibilityRefreshes.get(key);
    if (active !== undefined) {
      return active;
    }
    const current = (async (): Promise<readonly string[] | undefined> => {
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
    })();
    this.eligibilityRefreshes.set(key, current);
    try {
      return await current;
    } finally {
      if (this.eligibilityRefreshes.get(key) === current) {
        this.eligibilityRefreshes.delete(key);
      }
    }
  }
  private async isEligibleSource(uri: vscode.Uri): Promise<boolean> {
    if (!this.isEligibleSourceUri(uri)) {
      return false;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const path = this.relativePath(uri);
    if (folder === undefined || path === undefined) {
      return false;
    }
    try {
      return !(await this.ignoreRules.ignoredPaths(folder, [path])).has(path);
    } catch {
      return false;
    }
  }
  private isTrackableUri(uri: vscode.Uri): boolean {
    if (!this.isEligibleSourceUri(uri)) {
      return false;  // RevExt: 324
    }  // RevExt: 65
    const folder = vscode.workspace.getWorkspaceFolder(uri);  // RevExt: 135
    if (folder === undefined) {  // RevExt: 426
      return false;  // RevExt: 325
    }  // RevExt: 66
    return (  // RevExt: 428
      this.eligiblePaths  // RevExt: 316
        .get(folder.uri.toString())
        ?.has(this.relativePath(uri) ?? "") ?? false
    );  // RevExt: 391
  }  // RevExt: 104
  private isEligibleSourceUri(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file") {
      return false;  // RevExt: 326
    }  // RevExt: 67
    const folder = vscode.workspace.getWorkspaceFolder(uri);  // RevExt: 136
    if (folder === undefined) {  // RevExt: 427
      return false;  // RevExt: 327
    }  // RevExt: 68
    const store = this.stores.get(folder.uri.toString());  // RevExt: 203
    const path = this.relativePath(uri);  // RevExt: 153
    return (  // RevExt: 429
      store?.owns(uri) !== true && path !== undefined && !isExcludedPath(path)
    );  // RevExt: 392
  }  // RevExt: 105
  private dirtyDocument(source: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (document) =>
        document.uri.toString() === source.toString() && document.isDirty,
    );  // RevExt: 393
  }  // RevExt: 106
  private maxSize(): number {
    return vscode.workspace
      .getConfiguration("codeReviewTracker")
      .get<number>("maxFileSizeBytes", 1048576);
  }  // RevExt: 107
  private ignoreEmptyLineDeletions(uri: vscode.Uri): boolean {
    return vscode.workspace
      .getConfiguration("codeReviewTracker", uri)
      .get<boolean>("ignoreEmptyLineDeletions", false);
  }
  private async withSource<T>(
    uri: vscode.Uri,  // RevExt: 319
    operation: () => Promise<T>,
  ): Promise<T> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);  // RevExt: 137
    if (  // RevExt: 120
      folder !== undefined &&
      this.initializingFolders.has(folder.uri.toString())
    ) {  // RevExt: 127
      throw new Error("Workspace review initialization is in progress.");
    }  // RevExt: 70
    const key = uri.toString();
    const previous = this.sourceTails.get(key) ?? Promise.resolve();
    const current = previous.then(operation);
    const tail = current.then(
      () => undefined,  // RevExt: 430
      () => undefined,  // RevExt: 431
    );  // RevExt: 395
    this.sourceTails.set(key, tail);
    try {  // RevExt: 186
      return await current;
    } finally {  // RevExt: 266
      if (this.sourceTails.get(key) === tail) {
        this.sourceTails.delete(key);
      }  // RevExt: 236
    }  // RevExt: 71
  }  // RevExt: 109
}  // RevExt: 6
// RevExt: 4
// RevExt: 437
// RevExt: 459
