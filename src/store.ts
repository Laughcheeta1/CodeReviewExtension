import * as vscode from "vscode";
import { fileStatus, type FileRecord } from "./domain";
import {
  coalesced,
  forEachConcurrent,
  serialized,
  STORE_CONCURRENCY_LIMIT,
} from "./concurrency";
import {
  folderHash,
  describeStoredFileProblem,
  parseStoredFile,
  storageFileName,
  storedFile,
  summarize,
  type FileSummary,
} from "./storage-format";
import { decodeSnapshot } from "./snapshot";
import { isFileNotFound } from "./errors";
import {
  compileTrackingMatcher,
  parseInitializationConfiguration,
  tracksPathCompiled,
  type CompiledTrackingMatcher,
  type InitializationConfiguration,
  type TrackingTarget,
} from "./tracking";
import { StoreFileSystem } from "./store-io";
import { maybeMigrateLegacy } from "./store-migration";
const decoder = new TextDecoder("utf-8", { fatal: true });
const CACHE_LIMIT = 8;

function decodeStoredFile(bytes: Uint8Array): ReturnType<typeof parseStoredFile> {
  return parseStoredFile(JSON.parse(decoder.decode(bytes)));
}

function describeStoredBytes(bytes: Uint8Array, expectedPath: string): string {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    return `stored JSON for "${expectedPath}" is not valid UTF-8 JSON: ${String(error)}`;
  }
  return describeStoredFileProblem(value, expectedPath);
}

function parseAndValidateStoredFile(bytes: Uint8Array, expectedPath: string): FileRecord {
  const parsed = decodeStoredFile(bytes);
  if (parsed === undefined || parsed.path !== expectedPath) {
    throw new Error(
      `Invalid v4 per-file review metadata for "${expectedPath}": ${describeStoredBytes(bytes, expectedPath)}`,
    );
  }
  return parsed.file;
}
const INITIALIZATION_FILE = "initialization.json";

function legacyDirectoryUri(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(folder.uri, ".vscode", "code-review-tracker");
}

function legacySnapshotsUri(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(legacyDirectoryUri(folder), "snapshots");
}

export class PersistentStore {
  private readonly summaries = new Map<string, FileSummary>();
  private readonly cache = new Map<string, FileRecord | undefined>();
  private readonly loadTails = new Map<string, Promise<FileRecord | undefined>>();
  private readonly writeTails = new Map<string, Promise<unknown>>();
  private readonly initializationTails = new Map<string, Promise<unknown>>();
  private readonly directoryUri: vscode.Uri;
  private readonly snapshotsUri: vscode.Uri;
  private readonly initializationUri: vscode.Uri;
  private readonly fileSystem: StoreFileSystem;
  private readonly legacyDirectoryUri: vscode.Uri;
  private readonly legacySnapshotsUri: vscode.Uri;
  private readonly legacyUri: vscode.Uri;
  private readonly legacyBackupUri: vscode.Uri;
  private readonly directoryUriString: string;
  private readonly directoryPrefix: string;
  private readonly legacyDirectoryString: string;
  private readonly legacyDirectoryPrefix: string;
  private readonly legacyUriString: string;
  private readonly legacyBackupUriString: string;
  private initializationConfiguration: InitializationConfiguration | undefined;
  private compiledMatcher: CompiledTrackingMatcher = compileTrackingMatcher(undefined);
  constructor(
    private readonly folder: vscode.WorkspaceFolder,
    private readonly log: vscode.LogOutputChannel,
    storageUri: vscode.Uri | undefined,
  ) {
    if (storageUri === undefined) {
      throw new Error(
        `Workspace storage is unavailable for ${folder.uri.fsPath}; ExtensionContext.storageUri must be provided.`,
      );
    }
    this.directoryUri = vscode.Uri.joinPath(
      storageUri,
      folderHash(folder.uri.toString()),
    );
    this.snapshotsUri = vscode.Uri.joinPath(this.directoryUri, "snapshots");
    this.initializationUri = vscode.Uri.joinPath(
      this.directoryUri,
      INITIALIZATION_FILE,
    );
    this.fileSystem = new StoreFileSystem(
      this.directoryUri,
      this.snapshotsUri,
      this.initializationUri,
      this.log,
    );
    this.legacyDirectoryUri = legacyDirectoryUri(folder);
    this.legacySnapshotsUri = legacySnapshotsUri(folder);
    this.legacyUri = vscode.Uri.joinPath(
      folder.uri,
      ".vscode",
      "code-review-tracker.json",
    );
    this.legacyBackupUri = vscode.Uri.joinPath(
      folder.uri,
      ".vscode",
      "code-review-tracker.v1.migrated.json",
    );
    this.directoryUriString = this.directoryUri.toString();
    this.directoryPrefix = `${this.directoryUriString}/`;
    this.legacyDirectoryString = this.legacyDirectoryUri.toString();
    this.legacyDirectoryPrefix = `${this.legacyDirectoryString}/`;
    this.legacyUriString = this.legacyUri.toString();
    this.legacyBackupUriString = this.legacyBackupUri.toString();
  }

  /** Exposed for tests and the activation API; the directory is workspace-specific. */
  get storeDirectoryUri(): vscode.Uri {
    return this.directoryUri;
  }
  get paths(): readonly string[] {
    return [...this.summaries.keys()];
  }
  get hasMetadata(): boolean {
    return this.summaries.size > 0;
  }
  get initializationState(): "unconfigured" | "disabled" | "initialized" {
    return this.initializationConfiguration?.state ?? "unconfigured";
  }
  async initialize(): Promise<void> {
    await this.maybeMigrateLegacy();
    await this.loadInitialization();
    const safeToClean = await this.loadSummaries();
    if (this.initializationConfiguration === undefined && this.hasMetadata) {
      this.initializationConfiguration = {
        schemaVersion: 1,
        state: "initialized",
        targets: [{ kind: "folder", path: "" }],
      };
      this.syncCompiledMatcher();
    }
    if (safeToClean) {
      await this.cleanupSnapshots();
    }
    this.log.info(
      `Review store initialized for ${this.folder.uri.fsPath}: ` +
        `state=${this.initializationState}, metadataFiles=${this.summaries.size}, ` +
        `snapshotsCleaned=${safeToClean}, storage=${this.directoryUri.toString()}.`,
    );
  }
  tracksPath(path: string): boolean {
    return tracksPathCompiled(path, this.compiledMatcher);
  }
  async disableTracking(): Promise<void> {
    const configuration = { schemaVersion: 1, state: "disabled" } as const;
    await serialized(this.initializationTails, INITIALIZATION_FILE, () =>
      this.writeInitialization(configuration),
    );
  }
  async enableTracking(targets: readonly TrackingTarget[]): Promise<void> {
    const configuration = {
      schemaVersion: 1,
      state: "initialized",
      targets,
    } as const;
    await serialized(this.initializationTails, INITIALIZATION_FILE, () =>
      this.writeInitialization(configuration),
    );
  }
  private async writeInitialization(configuration: InitializationConfiguration): Promise<void> {
    await this.fileSystem.writeInitialization(configuration);
    this.initializationConfiguration = configuration;
    this.compiledMatcher = compileTrackingMatcher(configuration);
  }
  async includeTrackingTarget(target: TrackingTarget): Promise<boolean> {
    return this.includeTrackingTargets([target]);
  }
  async includeTrackingTargets(
    candidates: readonly TrackingTarget[],
  ): Promise<boolean> {
    return serialized(this.initializationTails, INITIALIZATION_FILE, () =>
      this.includeTrackingTargetsSerialized(candidates),
    );
  }
  private async includeTrackingTargetsSerialized(
    candidates: readonly TrackingTarget[],
  ): Promise<boolean> {
    const targets = this.initializationConfiguration?.targets;
    if (
      this.initializationState !== "initialized" ||
      targets === undefined
    ) {
      return false;
    }
    const seen = new Set<string>();
    const additions: TrackingTarget[] = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.path)) {
        continue;
      }
      seen.add(candidate.path);
      if (!this.tracksPath(candidate.path)) {
        additions.push(candidate);
      }
    }
    if (additions.length === 0) {
      return false;
    }
    await this.writeInitialization({
      schemaVersion: 1,
      state: "initialized",
      targets: [...targets, ...additions],
    });
    return true;
  }
  trackingTargets(): readonly TrackingTarget[] | undefined {
    return this.initializationConfiguration?.targets;
  }
  owns(uri: vscode.Uri): boolean {
    const value = uri.toString();
    return (
      value.startsWith(this.directoryPrefix) ||
      value === this.directoryUriString ||
      value.startsWith(this.legacyDirectoryPrefix) ||
      value === this.legacyDirectoryString ||
      value === this.legacyUriString ||
      value === this.legacyBackupUriString
    );
  }
  peek(path: string): FileRecord | undefined {
    const file = this.cache.get(path);
    if (this.cache.has(path)) {
      this.touch(path, file);
    }
    return file;
  }
  hasLoaded(path: string): boolean {
    return this.cache.has(path);
  }
  summary(path: string): FileSummary | undefined {
    return this.summaries.get(path);
  }
  async load(path: string): Promise<FileRecord | undefined> {
    if (this.cache.has(path)) {
      return this.peek(path);
    }
    return coalesced(this.loadTails, path, () => this.loadUncached(path));
  }
  private async loadUncached(path: string): Promise<FileRecord | undefined> {
    const fileUri = this.fileSystem.fileUri(path);
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const file = parseAndValidateStoredFile(bytes, path);
      this.summaries.set(path, summarize(file));
      this.touch(path, file);
      return file;
    } catch (error) {
      if (isFileNotFound(error)) {
        this.touch(path, undefined);
        return undefined;
      }
      this.log.warn(
        `Unable to load review metadata for "${path}" ` +
          `at ${fileUri.toString()} (folder ${this.folder.uri.fsPath}): ${String(error)}`,
      );
      throw error;
    }
  }
  async loadBaseline(file: FileRecord, maxSize: number): Promise<Uint8Array> {
    const snapshot = vscode.Uri.joinPath(this.snapshotsUri, file.baseline.file);
    const compressed = await vscode.workspace.fs.readFile(snapshot);
    return decodeSnapshot(
      compressed,
      file.baseline.digest,
      file.baseline.size,
      maxSize,
    );
  }
  async commit(
    path: string,
    file: FileRecord,
    baselineBytes?: Uint8Array,
  ): Promise<void> {
    const normalized = { ...file, fileStatus: fileStatus(file) };
    const staged = storedFile(path, normalized);
    const stagedProblem =
      parseStoredFile(JSON.parse(JSON.stringify(staged))) === undefined
        ? describeStoredFileProblem(
            JSON.parse(JSON.stringify(staged)),
            path,
          )
        : undefined;
    if (stagedProblem !== undefined) {
      throw new Error(
        `Refusing to persist invalid v4 review metadata for "${path}" ` +
          `(baseline ${normalized.baseline.digest.slice(0, 12)}…, ` +
          `current ${normalized.current.digest.slice(0, 12)}…, ` +
          `${normalized.currentLines.length} current/${normalized.deletedLines.length} deleted lines, ` +
          `${normalized.hunks.length} hunks): ${stagedProblem}`,
      );
    }
    await this.enqueue(path, async () => {
      const previous = this.cache.has(path)
        ? this.cache.get(path)
        : await this.loadDirect(path);
      if (baselineBytes !== undefined) {
        await this.fileSystem.writeSnapshot(normalized, baselineBytes);
      }
      await this.fileSystem.writeJson(path, normalized);
      this.summaries.set(path, summarize(normalized));
      this.touch(path, normalized);
      if (
        previous !== undefined &&
        previous.baseline.file !== normalized.baseline.file
      ) {
        await this.fileSystem.deleteSnapshot(previous.baseline.file);
      }
    });
  }
  async delete(path: string): Promise<void> {
    await this.enqueue(path, async () => {
      let previous: FileRecord | undefined;
      try {
        previous = await this.loadDirect(path);
      } catch (error) {
        this.log.warn(
          `Deleting unreadable review metadata for "${path}" ` +
            `at ${this.fileSystem.fileUri(path).toString()}: ${String(error)}`,
        );
      }
      try {
        await vscode.workspace.fs.delete(this.fileSystem.fileUri(path), {
          useTrash: false,
        });
      } catch (error) {
        if (!isFileNotFound(error)) {
          throw error;
        }
      }
      if (previous !== undefined) {
        await this.fileSystem.deleteSnapshot(previous.baseline.file);
      }
      this.summaries.delete(path);
      this.cache.delete(path);
    });
  }
  async reset(): Promise<void> {
    await Promise.allSettled(this.initializationTails.values());
    const initializationConfiguration = this.initializationConfiguration;
    await Promise.allSettled(this.writeTails.values());
    try {
      await vscode.workspace.fs.delete(this.directoryUri, {
        recursive: true,
        useTrash: false,
      });
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }
    for (const legacy of [this.legacyUri, this.legacyBackupUri]) {
      try {
        await vscode.workspace.fs.delete(legacy, { useTrash: false });
      } catch (error) {
        if (!isFileNotFound(error)) {
          throw error;
        }
      }
    }
    this.summaries.clear();
    this.cache.clear();
    this.loadTails.clear();
    this.writeTails.clear();
    if (initializationConfiguration !== undefined) {
      await this.fileSystem.writeInitialization(initializationConfiguration);
      this.initializationConfiguration = initializationConfiguration;
    }
  }
  private async maybeMigrateLegacy(): Promise<void> {
    await maybeMigrateLegacy({
      directoryUri: this.directoryUri,
      initializationUri: this.initializationUri,
      legacyDirectoryUri: this.legacyDirectoryUri,
      legacySnapshotsUri: this.legacySnapshotsUri,
      fileSystem: this.fileSystem,
      log: this.log,
    });
  }

  private syncCompiledMatcher(): void {
    this.compiledMatcher = compileTrackingMatcher(this.initializationConfiguration);
  }

  private async loadInitialization(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.initializationUri);
      let raw: unknown;
      try {
        raw = JSON.parse(decoder.decode(bytes));
      } catch (error) {
        throw new Error(
          `initialization file at ${this.initializationUri.toString()} is not valid JSON: ${String(error)}`,
        );
      }
      const configuration = parseInitializationConfiguration(raw);
      if (configuration === undefined) {
        throw new Error(
          `Invalid initialization configuration at ${this.initializationUri.toString()}: ` +
            `expected { schemaVersion: 1, state: "disabled" } or ` +
            `{ schemaVersion: 1, state: "initialized", targets: [...] }; got ${JSON.stringify(raw)?.slice(0, 300)}`,
        );
      }
      this.initializationConfiguration = configuration;
      this.syncCompiledMatcher();
      this.log.info(
        `Loaded initialization for ${this.folder.uri.fsPath}: ` +
          `state=${configuration.state}, ` +
          `targets=${configuration.targets?.length ?? 0}.`,
      );
    } catch (error) {
      if (!isFileNotFound(error)) {
        this.log.warn(
          `Unable to load initialization configuration for ${this.folder.uri.fsPath} ` +
            `at ${this.initializationUri.toString()}: ${String(error)}`,
        );
      }
    }
  }
  private async loadSummaries(): Promise<boolean> {
    let entries: readonly [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.directoryUri);
    } catch (error) {
      if (isFileNotFound(error)) {
        this.log.info(
          `No review storage directory yet for ${this.folder.uri.fsPath} at ${this.directoryUri.toString()}; starting empty.`,
        );
        return true;
      }
      this.log.warn(
        `Unable to scan review metadata for ${this.folder.uri.fsPath} ` +
          `at ${this.directoryUri.toString()}: ${String(error)}`,
      );
      return false;
    }
    let valid = true;
    let loaded = 0;
    let ignored = 0;
    await forEachConcurrent(entries, STORE_CONCURRENCY_LIMIT, async ([name, type]) => {
      if (name === INITIALIZATION_FILE) {
        return;
      }
      if ((type & vscode.FileType.File) !== 0 && name.includes(".tmp-")) {
        await this.fileSystem.deleteTemporary(
          vscode.Uri.joinPath(this.directoryUri, name),
        );
        return;
      }
      if ((type & vscode.FileType.File) === 0 || !name.endsWith(".json")) {
        return;
      }
      try {
        const metadata = vscode.Uri.joinPath(this.directoryUri, name);
        const bytes = await vscode.workspace.fs.readFile(metadata);
        let raw: unknown;
        try {
          raw = JSON.parse(decoder.decode(bytes));
        } catch (error) {
          throw new Error(
            `file ${name} is not valid JSON: ${String(error)}`,
          );
        }
        const parsed = parseStoredFile(raw);
        if (parsed === undefined) {
          throw new Error(
            `file ${name}: ${describeStoredFileProblem(raw)}`,
          );
        }
        if (storageFileName(parsed.path) !== name) {
          throw new Error(
            `file ${name} stores path "${parsed.path}" but is named for a different source ` +
              `(expected ${storageFileName(parsed.path)}); the file may have been copied or hashed under another path`,
          );
        }
        this.summaries.set(parsed.path, summarize(parsed.file));
        loaded += 1;
      } catch (error) {
        valid = false;
        ignored += 1;
        this.log.warn(
          `Ignoring metadata file ${name} for ${this.folder.uri.fsPath} ` +
            `at ${vscode.Uri.joinPath(this.directoryUri, name).toString()}: ${String(error)}`,
        );
      }
    });
    this.log.info(
      `Scanned review metadata for ${this.folder.uri.fsPath}: ` +
        `${loaded} valid, ${ignored} ignored, safeToCleanSnapshots=${valid}.`,
    );
    return valid;
  }
  private async cleanupSnapshots(): Promise<void> {
    let entries: readonly [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.snapshotsUri);
    } catch (error) {
      if (!isFileNotFound(error)) {
        this.log.warn(
          `Unable to clean snapshots for ${this.folder.uri.fsPath} ` +
            `at ${this.snapshotsUri.toString()}: ${String(error)}`,
        );
      }
      return;
    }
    const referenced = new Set(
      [...this.summaries.values()].map((summary) => summary.baselineFile),
    );
    for (const [name, type] of entries) {
      if ((type & vscode.FileType.File) === 0) {
        continue;
      }
      if (
        name.includes(".tmp-") ||
        (name.endsWith(".gz") && !referenced.has(name))
      ) {
        await this.fileSystem.deleteSnapshot(name);
      }
    }
  }
  private async loadDirect(path: string): Promise<FileRecord | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileSystem.fileUri(path));
      return parseAndValidateStoredFile(bytes, path);
    } catch (error) {
      if (isFileNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }
  private touch(path: string, file: FileRecord | undefined): void {
    this.cache.delete(path);
    this.cache.set(path, file);
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
  }
  private async enqueue(
    path: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    await serialized(this.writeTails, path, operation);
  }
}

