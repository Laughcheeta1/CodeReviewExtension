import * as vscode from "vscode";
import {
  buildDiffRecords,
  digestBytes,
  fileStatus,
  physicalLines,
  reviewableLines,
  setReviewer,
  type FileRecord,
  type RawGitHunk,
  type ReviewStatus,
  type Reviewer,
  type SourceSnapshot,
} from "./domain";
import { GitService } from "./git";
import { PersistentStore } from "./store";
import { snapshotFileName, sourceMayHaveChanged } from "./storage-format";
import { tracksPath, type TrackingTarget } from "./tracking";
import { revExtEdits, revExtRemovals } from "./revext";
// RevExt: 436
const BASELINE_SCHEME = "code-review-baseline";
const now = (): string => new Date().toISOString();
// RevExt: 1
interface BaselineIdentity {
  readonly source: vscode.Uri;
  readonly baselineDigest: string;
  readonly currentDigest: string;
}  // RevExt: 5
export class ReviewService implements vscode.Disposable {
  private readonly stores = new Map<string, PersistentStore>();
  private readonly eligiblePaths = new Map<string, Set<string>>();
  private readonly sourceTails = new Map<string, Promise<void>>();
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
  ) {}
// RevExt: 2
  async initialize(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const store = new PersistentStore(folder, this.log);
      await store.initialize();
      this.stores.set(folder.uri.toString(), store);
    }  // RevExt: 12
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
    const next = new Set(paths.filter((path) => store?.tracksPath(path)));
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
    }  // RevExt: 18
  }  // RevExt: 82
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
        for (const path of paths) {
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
        }  // RevExt: 21
      },  // RevExt: 453
    );  // RevExt: 447
    if (changed > 0 || hidden > 0) {
      this.log.info(
        `Review reconciliation updated ${changed} and hid ${hidden} missing files.`,
      );  // RevExt: 241
      this.changedEmitter.fire(undefined);  // RevExt: 129
    }  // RevExt: 22
  }  // RevExt: 83
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
  async reconcileCreatedSource(uri: vscode.Uri): Promise<void> {
    const path = this.relativePath(uri);  // RevExt: 151
    const store = this.storeFor(uri);  // RevExt: 155
    const folder = vscode.workspace.getWorkspaceFolder(uri);  // RevExt: 133
    if (  // RevExt: 115
      path === undefined ||  // RevExt: 251
      store === undefined ||  // RevExt: 253
      folder === undefined ||
      !this.isEligibleSourceUri(uri) ||
      !store.tracksPath(path)  // RevExt: 457
    ) {  // RevExt: 122
      return;  // RevExt: 165
    }  // RevExt: 23
    const stat = await vscode.workspace.fs.stat(uri);  // RevExt: 255
    if ((stat.type & vscode.FileType.File) === 0) {
      return;  // RevExt: 166
    }  // RevExt: 24
    this.eligiblePaths.get(folder.uri.toString())?.add(path);
    if (await this.withSource(uri, () => this.recompute(uri, true, true))) {
      this.changedEmitter.fire(uri);
    }  // RevExt: 25
  }  // RevExt: 84
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
    if (  // RevExt: 116
      store === undefined ||  // RevExt: 254
      path === undefined ||  // RevExt: 252
      !this.isEligibleSourceUri(document.uri) ||
      !store.tracksPath(path)  // RevExt: 458
    ) {  // RevExt: 123
      return;  // RevExt: 169
    }  // RevExt: 28
    this.eligiblePaths
      .get(vscode.workspace.getWorkspaceFolder(document.uri)!.uri.toString())
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
              if (!this.isEligibleSourceUri(uri)) {
                continue;
              }  // RevExt: 259
              let { bytes, source } = await this.readStableSource(
                uri,
                maxSize,
              );  // RevExt: 261
              let nextRevExtId = 1;
              if (status === "pending") {
                nextRevExtId = await this.annotatePendingDocument(uri);
                ({ bytes, source } = await this.readStableSource(uri, maxSize));
              }  // RevExt: 260
              const baseline = status === "reviewed" ? bytes : new Uint8Array();
              const file = await this.createRecord(
                path,
                baseline,
                bytes,
                source,
                status === "reviewed" ? now() : undefined,
                status === "pending" ? initialAdditionHunks(bytes) : undefined,
              );  // RevExt: 262
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
      const file = await this.requireFresh(identity.source, identity);
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
    return this.withSource(source, async () => {  // RevExt: 280
      if (this.dirtyDocument(source) !== undefined) {  // RevExt: 282
        throw new Error("Save the file before opening its review diff.");
      }  // RevExt: 217
      await this.recompute(source, true);  // RevExt: 285
      const path = this.relativePath(source);
      const store = this.storeFor(source);
      const file = path === undefined ? undefined : await store?.load(path);
      return file === undefined
        ? undefined
        : { baseline: this.baselineUri(source, file), file };
    });  // RevExt: 269
  }  // RevExt: 90
  async markEditor(
    editor: vscode.TextEditor,
    status: ReviewStatus,  // RevExt: 287
    reviewer?: Reviewer,  // RevExt: 290
  ): Promise<boolean> {  // RevExt: 292
    const identity = this.parseBaselineUri(editor.document.uri);
    const source = identity?.source ?? editor.document.uri;
    const selected = selectedLines(editor.selections);
    return this.withSource(source, async () => {  // RevExt: 281
      if (this.dirtyDocument(source) !== undefined) {  // RevExt: 283
        throw new Error("Save the file before changing review state.");  // RevExt: 296
      }  // RevExt: 218
      const file = await this.requireFresh(source, identity);
      return this.applyReview(
        source,  // RevExt: 298
        file,  // RevExt: 302
        status,  // RevExt: 304
        reviewer,  // RevExt: 306
        (line) =>  // RevExt: 308
          identity === undefined &&
          line.changeType !== "unchanged" &&
          selected.has(line.line),
        (line) => identity !== undefined && selected.has(line.baselineLine),
      );  // RevExt: 246
    });  // RevExt: 270
  }  // RevExt: 91
  async markFile(
    source: vscode.Uri,
    status: ReviewStatus,
    reviewer?: Reviewer,
  ): Promise<boolean> {
    return this.withSource(source, async () => {
      if (this.dirtyDocument(source) !== undefined) {
        throw new Error("Save the file before changing review state.");
      }
      const file = await this.requireFresh(source);
      if (status === "pending" && reviewableLines(file).length === 0) {
        return this.initializePendingFile(source);
      }
      return this.applyReview(
        source,
        file,
        status,
        reviewer,
        (line) => line.changeType !== "unchanged",
        () => true,
      );
    });
  }
  private async initializePendingFile(source: vscode.Uri): Promise<boolean> {
    const path = this.relativePath(source);
    const store = this.storeFor(source);
    if (
      path === undefined ||
      store === undefined ||
      store.initializationState !== "initialized" ||
      !store.tracksPath(path) ||
      !this.isTrackableUri(source)
    ) {
      throw new Error("This file has not been initialized for review.");
    }
    let { bytes, source: snapshot } = await this.readStableSource(
      source,
      this.maxSize(),
    );
    const nextRevExtId = await this.annotatePendingDocument(source);
    ({ bytes, source: snapshot } = await this.readStableSource(
      source,
      this.maxSize(),
    ));
    const baseline = new Uint8Array();
    await store.commit(
      path,
      {
        ...(await this.createRecord(
          path,
          baseline,
          bytes,
          snapshot,
          undefined,
          initialAdditionHunks(bytes),
        )),
        nextRevExtId,
      },
      baseline,
    );
    this.changedEmitter.fire(source);
    return true;
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
  ): Promise<boolean> {  // RevExt: 293
    const path = this.relativePath(uri);  // RevExt: 152
    const store = this.storeFor(uri);  // RevExt: 156
    if (path === undefined || store === undefined) {  // RevExt: 158
      return false;  // RevExt: 320
    }  // RevExt: 40
    const existing = await store.load(path);  // RevExt: 328
    if (existing === undefined) {  // RevExt: 330
      if (!createMissing) {
        return false;  // RevExt: 332
      }  // RevExt: 225
      const { bytes, source } = await this.readStableSource(
        uri,
        this.maxSize(),  // RevExt: 334
      );  // RevExt: 248
      const baseline = new Uint8Array();
      await store.commit(
        path,
        await this.createRecord(path, baseline, bytes, source),
        baseline,
      );  // RevExt: 249
      return true;  // RevExt: 336
    }  // RevExt: 41
    const stat = await vscode.workspace.fs.stat(uri);  // RevExt: 256
    if (  // RevExt: 117
      !forceDigest &&
      !sourceMayHaveChanged(stat.mtime, stat.size, existing.current)
    ) {  // RevExt: 124
      return false;  // RevExt: 321
    }  // RevExt: 42
    const { bytes, source } = await this.readStableSource(uri, this.maxSize());
    const digest = digestBytes(bytes);
    if (digest === existing.current.digest) {
      if (  // RevExt: 338
        source.modifiedAt === existing.current.modifiedAt &&
        source.size === existing.current.size
      ) {  // RevExt: 340
        return false;  // RevExt: 333
      }  // RevExt: 226
      await store.commit(path, {  // RevExt: 343
        ...existing,
        current: { ...existing.current, ...source },
        updatedAt: now(),  // RevExt: 345
      });  // RevExt: 194
      return true;  // RevExt: 337
    }  // RevExt: 43
    const baseline = await store.loadBaseline(existing, this.maxSize());  // RevExt: 347
    const rawHunks = await this.diffWithProgress(uri, baseline, bytes);
    const diff = buildDiffRecords(baseline, bytes, rawHunks, existing);
    await store.commit(path, {
      ...existing,
      ...diff,  // RevExt: 349
      current: {  // RevExt: 351
        digest,
        ...source,  // RevExt: 353
        gitAlgorithm: "myers",  // RevExt: 355
        generatedAt: now(),
      },  // RevExt: 357
      updatedAt: now(),
    });  // RevExt: 272
    return true;  // RevExt: 360
  }  // RevExt: 95
  private async recomputeSavedDocument(
    document: vscode.TextDocument,
  ): Promise<boolean> {  // RevExt: 294
    const path = this.relativePath(document.uri);  // RevExt: 177
    const store = this.storeFor(document.uri);  // RevExt: 180
    if (path === undefined || store === undefined) {  // RevExt: 159
      return false;  // RevExt: 322
    }  // RevExt: 44
    const existing = await store.load(path);  // RevExt: 329
    if (existing === undefined) {  // RevExt: 331
      return this.recompute(document.uri, true, true);  // RevExt: 362
    }  // RevExt: 45
    const { bytes } = await this.readStableSource(document.uri, this.maxSize());
    const baseline = await store.loadBaseline(existing, this.maxSize());  // RevExt: 348
    const hunks = await this.diffWithProgress(document.uri, baseline, bytes);
    const addedLines = new Set<number>();
    for (const hunk of hunks) {
      for (
        let line = hunk.newStart;
        line < hunk.newStart + hunk.newCount;
        line += 1
      ) {  // RevExt: 341
        addedLines.add(line);
      }  // RevExt: 227
    }  // RevExt: 46
    const annotation = revExtEdits(  // RevExt: 364
      Array.from(  // RevExt: 366
        { length: document.lineCount },  // RevExt: 369
        (_, index) => document.lineAt(index).text,  // RevExt: 372
      ),  // RevExt: 375
      addedLines,
      document.languageId,  // RevExt: 380
      existing.nextRevExtId,
    );  // RevExt: 383
    if (annotation.edits.length === 0) {  // RevExt: 396
      return this.recompute(document.uri, true, true);  // RevExt: 363
    }  // RevExt: 47
    const edit = new vscode.WorkspaceEdit();  // RevExt: 398
    for (const change of annotation.edits) {  // RevExt: 400
      const line = document.lineAt(change.line - 1);  // RevExt: 402
      edit.insert(document.uri, line.range.end, change.suffix);
    }  // RevExt: 48
    if (!(await vscode.workspace.applyEdit(edit))) {  // RevExt: 404
      throw new Error("Could not add RevExt identity comments.");
    }  // RevExt: 49
    this.internalSaves.add(document.uri.toString());
    try {  // RevExt: 184
      if (!(await document.save())) {  // RevExt: 406
        throw new Error("Could not save RevExt identity comments.");
      }  // RevExt: 228
    } finally {  // RevExt: 264
      this.internalSaves.delete(document.uri.toString());
    }  // RevExt: 50
    const changed = await this.recompute(document.uri, true, true);
    const updated = await store.load(path);
    if (updated !== undefined && updated.nextRevExtId !== annotation.nextId) {
      await store.commit(path, {  // RevExt: 344
        ...updated,
        nextRevExtId: annotation.nextId,
        updatedAt: now(),  // RevExt: 346
      });  // RevExt: 195
    }  // RevExt: 51
    return changed;
  }  // RevExt: 96
  private async annotatePendingDocument(uri: vscode.Uri): Promise<number> {
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty) {
      throw new Error("Save the file before starting pending review.");
    }  // RevExt: 52
    const annotation = revExtEdits(  // RevExt: 365
      Array.from(  // RevExt: 367
        { length: document.lineCount },  // RevExt: 370
        (_, index) => document.lineAt(index).text,  // RevExt: 373
      ),  // RevExt: 376
      new Set(  // RevExt: 408
        Array.from({ length: document.lineCount }, (_, index) => index + 1),
      ),  // RevExt: 377
      document.languageId,  // RevExt: 381
      1,
    );  // RevExt: 384
    if (annotation.edits.length === 0) {  // RevExt: 397
      return annotation.nextId;
    }  // RevExt: 53
    const edit = new vscode.WorkspaceEdit();  // RevExt: 399
    for (const change of annotation.edits) {  // RevExt: 401
      const line = document.lineAt(change.line - 1);  // RevExt: 403
      edit.insert(uri, line.range.end, change.suffix);
    }  // RevExt: 54
    if (!(await vscode.workspace.applyEdit(edit))) {  // RevExt: 405
      throw new Error("Could not add initial RevExt identity comments.");
    }  // RevExt: 55
    this.internalSaves.add(uri.toString());
    try {  // RevExt: 185
      if (!(await document.save())) {  // RevExt: 407
        throw new Error("Could not save initial RevExt identity comments.");
      }  // RevExt: 229
    } finally {  // RevExt: 265
      this.internalSaves.delete(uri.toString());
    }  // RevExt: 56
    return annotation.nextId;
  }  // RevExt: 97
  private async diffWithProgress(
    source: vscode.Uri,
    baseline: Uint8Array,
    current: Uint8Array,
  ): Promise<readonly RawGitHunk[]> {
    const path = this.relativePath(source) ?? source.fsPath;
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Code Review: comparing ${path}`,
      },
      () => this.git.diff(baseline, current),
    );
  }
  private async createRecord(
    path: string,
    baseline: Uint8Array,
    current: Uint8Array,
    source: SourceSnapshot,
    lastReviewTime?: string,
    rawHunks?: readonly RawGitHunk[],
  ): Promise<FileRecord> {  // RevExt: 410
    const baselineDigest = digestBytes(baseline);
    const generatedAt = now();
    const diff = buildDiffRecords(
      baseline,
      current,
      rawHunks ?? (await this.git.diff(baseline, current)),
    );  // RevExt: 385
    return {  // RevExt: 275
      baseline: {
        file: snapshotFileName(path, baselineDigest),
        digest: baselineDigest,
        codec: "gzip",
        size: baseline.byteLength,
        createdAt: generatedAt,
      },  // RevExt: 358
      current: {  // RevExt: 352
        digest: digestBytes(current),
        ...source,  // RevExt: 354
        gitAlgorithm: "myers",  // RevExt: 356
        generatedAt,
      },  // RevExt: 359
      fileStatus: fileStatus(diff),
      nextRevExtId: 1,
      lastReviewTime,
      ...diff,  // RevExt: 350
      updatedAt: generatedAt,
    };  // RevExt: 277
  }  // RevExt: 98
  private async requireFresh(
    source: vscode.Uri,  // RevExt: 311
    identity?: BaselineIdentity,
  ): Promise<FileRecord> {  // RevExt: 411
    await this.recompute(source, true);
    const path = this.relativePath(source);  // RevExt: 147
    const file =
      path === undefined ? undefined : await this.storeFor(source)?.load(path);
    if (file === undefined) {
      throw new Error("This file has not been initialized for review.");
    }  // RevExt: 57
    if (  // RevExt: 118
      identity !== undefined &&
      (identity.baselineDigest !== file.baseline.digest ||
        identity.currentDigest !== file.current.digest)
    ) {  // RevExt: 125
      throw new Error(
        "This review diff is stale. Reopen Code Review: Open Review Diff.",
      );  // RevExt: 250
    }  // RevExt: 58
    return file;
  }  // RevExt: 99
  private async commitReview(
    source: vscode.Uri,  // RevExt: 312
    file: FileRecord,  // RevExt: 412
  ): Promise<void> {  // RevExt: 199
    const path = this.relativePath(source);  // RevExt: 148
    const store = this.storeFor(source);  // RevExt: 414
    if (path === undefined || store === undefined) {  // RevExt: 160
      return;  // RevExt: 171
    }  // RevExt: 59
    await store.commit(path, file);
    const changes = reviewableLines(file);
    if (  // RevExt: 119
      file.baseline.digest !== file.current.digest &&
      changes.length > 0 &&
      changes.every((line) => line.reviewStatus === "reviewed")
    ) {  // RevExt: 126
      await this.promote(source, file);
      return;  // RevExt: 172
    }  // RevExt: 60
    this.changedEmitter.fire(source);  // RevExt: 416
  }  // RevExt: 100
  private async applyReview(
    source: vscode.Uri,  // RevExt: 313
    file: FileRecord,  // RevExt: 413
    status: ReviewStatus,  // RevExt: 289
    reviewer: Reviewer | undefined,
    matchesCurrent: (line: FileRecord["currentLines"][number]) => boolean,
    matchesDeleted: (line: FileRecord["deletedLines"][number]) => boolean,
  ): Promise<boolean> {  // RevExt: 295
    const at = now();
    const lastReviewer = setReviewer(status, reviewer, at);
    const currentLines = file.currentLines.map((line) =>
      matchesCurrent(line)
        ? { ...line, reviewStatus: status, lastReviewer }  // RevExt: 418
        : line,  // RevExt: 420
    );  // RevExt: 386
    const deletedLines = file.deletedLines.map((line) =>
      matchesDeleted(line)
        ? { ...line, reviewStatus: status, lastReviewer }  // RevExt: 419
        : line,  // RevExt: 421
    );  // RevExt: 387
    const changed =
      currentLines.some((line, index) => line !== file.currentLines[index]) ||
      deletedLines.some((line, index) => line !== file.deletedLines[index]);
    if (!changed) {
      return false;  // RevExt: 323
    }  // RevExt: 61
    await this.commitReview(source, {
      ...file,
      currentLines,
      deletedLines,
      lastReviewTime: at,
      updatedAt: at,
    });  // RevExt: 273
    return true;  // RevExt: 361
  }  // RevExt: 101
  private async promote(
    source: vscode.Uri,  // RevExt: 314
    expected: FileRecord,
  ): Promise<void> {  // RevExt: 200
    const path = this.relativePath(source);  // RevExt: 149
    const store = this.storeFor(source);  // RevExt: 415
    if (path === undefined || store === undefined) {  // RevExt: 161
      return;  // RevExt: 173
    }  // RevExt: 62
    let { bytes, source: stat } = await this.readStableSource(
      source,
      this.maxSize(),
    );  // RevExt: 388
    if (digestBytes(bytes) !== expected.current.digest) {
      await this.recompute(source, true);  // RevExt: 286
      return;  // RevExt: 174
    }  // RevExt: 63
    const document = await vscode.workspace.openTextDocument(source);
    const removals = revExtRemovals(
      Array.from(  // RevExt: 368
        { length: document.lineCount },  // RevExt: 371
        (_, index) => document.lineAt(index).text,  // RevExt: 374
      ),  // RevExt: 378
      new Set(  // RevExt: 409
        expected.currentLines
          .filter((line) => line.changeType === "added")
          .map((line) => line.line),
      ),  // RevExt: 379
      document.languageId,  // RevExt: 382
    );  // RevExt: 389
    if (removals.length > 0) {
      const edit = new vscode.WorkspaceEdit();
      for (const removal of removals) {
        const line = document.lineAt(removal.line - 1);
        edit.delete(
          source,
          new vscode.Range(
            line.lineNumber,  // RevExt: 422
            removal.start,
            line.lineNumber,  // RevExt: 423
            line.range.end.character,
          ),
        );
      }  // RevExt: 230
      if (!(await vscode.workspace.applyEdit(edit))) {
        throw new Error("Could not remove RevExt identity comments.");
      }  // RevExt: 231
      this.internalSaves.add(source.toString());
      try {  // RevExt: 238
        if (!(await document.save())) {
          throw new Error("Could not save removed RevExt identity comments.");
        }  // RevExt: 191
      } finally {
        this.internalSaves.delete(source.toString());
      }  // RevExt: 232
      ({ bytes, source: stat } = await this.readStableSource(
        source,  // RevExt: 301
        this.maxSize(),  // RevExt: 335
      ));
    }  // RevExt: 64
    const promoted = await this.createRecord(
      path,
      bytes,  // RevExt: 424
      bytes,  // RevExt: 425
      stat,
      expected.lastReviewTime,
    );  // RevExt: 390
    await store.commit(path, promoted, bytes);
    this.changedEmitter.fire(source);  // RevExt: 417
    this.promotedEmitter.fire(source);
  }  // RevExt: 102
  private storeFor(uri: vscode.Uri): PersistentStore | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);  // RevExt: 134
    return folder === undefined  // RevExt: 139
      ? undefined  // RevExt: 141
      : this.stores.get(folder.uri.toString());
  }  // RevExt: 103
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
  private async readStableSource(
    uri: vscode.Uri,  // RevExt: 318
    maxSize: number,
  ): Promise<{
    bytes: Uint8Array;
    source: SourceSnapshot;
  }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await vscode.workspace.fs.stat(uri);
      if (before.size > maxSize) {
        throw new Error("File exceeds the configured size limit");
      }  // RevExt: 233
      const bytes = await vscode.workspace.fs.readFile(uri);
      const after = await vscode.workspace.fs.stat(uri);
      if (  // RevExt: 339
        before.mtime !== after.mtime ||
        before.size !== after.size ||
        bytes.byteLength !== after.size
      ) {  // RevExt: 342
        continue;  // RevExt: 212
      }  // RevExt: 234
      if (bytes.includes(0)) {
        throw new Error("Binary files are unsupported");
      }  // RevExt: 235
      physicalLines(bytes);
      return {
        bytes,
        source: { modifiedAt: after.mtime, size: after.size },
      };
    }  // RevExt: 69
    throw new Error(
      `Source changed while it was being read: ${uri.toString()}`,
    );  // RevExt: 394
  }  // RevExt: 108
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
function initialAdditionHunks(bytes: Uint8Array): readonly RawGitHunk[] {
  const count = physicalLines(bytes).length;
  return count === 0
    ? []
    : [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: count }];
}  // RevExt: 7
function progressIncrement(total: number): number {
  return total === 0 ? 0 : 100 / total;
}  // RevExt: 438
function selectedLines(
  selections: readonly vscode.Selection[],
): ReadonlySet<number> {
  const result = new Set<number>();
  for (const selection of selections) {
    const start = selection.start.line;
    const end =
      selection.end.line -
      (!selection.isEmpty && selection.end.character === 0 ? 1 : 0);
    for (let line = start; line <= Math.max(start, end); line += 1) {
      result.add(line + 1);
    }  // RevExt: 72
  }  // RevExt: 110
  return result;
}  // RevExt: 8
function isExcludedPath(path: string): boolean {
  return (  // RevExt: 432
    path === ".git" ||
    path.startsWith(".git/") ||
    path === "node_modules" ||
    path.startsWith("node_modules/") ||
    path === ".vscode/code-review-tracker" ||
    path.startsWith(".vscode/code-review-tracker/")
  );  // RevExt: 434
}  // RevExt: 10
function isFileNotFound(error: unknown): boolean {
  return (  // RevExt: 433
    error instanceof vscode.FileSystemError && error.code === "FileNotFound"
  );  // RevExt: 435
}  // RevExt: 11
// RevExt: 4
// RevExt: 437
// RevExt: 459
