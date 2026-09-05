import * as vscode from "vscode";
import { fileStatus, type FileRecord } from "./domain";
import { coalesced, serialized } from "./concurrency";
import {
  folderHash,
  parseStoredFile,
  storageFileName,
  summarize,
  type FileSummary,
} from "./storage-format";
import { decodeSnapshot } from "./snapshot";
import { isFileNotFound } from "./errors";
import {
  parseInitializationConfiguration,
  tracksPath,
  type InitializationConfiguration,
  type TrackingTarget,
} from "./tracking";
import { StoreFileSystem } from "./store-io";
const decoder = new TextDecoder("utf-8", { fatal: true });
const CACHE_LIMIT = 8;
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
  private readonly directoryUri: vscode.Uri;
  private readonly snapshotsUri: vscode.Uri;
  private readonly initializationUri: vscode.Uri;
  private readonly fileSystem: StoreFileSystem;
  private readonly legacyDirectoryUri: vscode.Uri;
  private readonly legacySnapshotsUri: vscode.Uri;
  private readonly legacyUri: vscode.Uri;
  private readonly legacyBackupUri: vscode.Uri;
  private initializationConfiguration: InitializationConfiguration | undefined;
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
    }
    if (safeToClean) {
      await this.cleanupSnapshots();
    }
  }
  tracksPath(path: string): boolean {
    return tracksPath(path, this.initializationConfiguration);
  }
  async disableTracking(): Promise<void> {
    const configuration = { schemaVersion: 1, state: "disabled" } as const;
    await this.fileSystem.writeInitialization(configuration);
    this.initializationConfiguration = configuration;
  }
  async enableTracking(targets: readonly TrackingTarget[]): Promise<void> {
    const configuration = {
      schemaVersion: 1,
      state: "initialized",
      targets,
    } as const;
    await this.fileSystem.writeInitialization(configuration);
    this.initializationConfiguration = configuration;
  }
  async includeTrackingTarget(target: TrackingTarget): Promise<boolean> {
    return this.includeTrackingTargets([target]);
  }
  async includeTrackingTargets(
    candidates: readonly TrackingTarget[],
  ): Promise<boolean> {
    const targets = this.initializationConfiguration?.targets;
    if (
      this.initializationState !== "initialized" ||
      targets === undefined
    ) {
      return false;
    }
    const additions = candidates.filter(
      (candidate) => !this.tracksPath(candidate.path),
    );
    if (additions.length === 0) {
      return false;
    }
    await this.enableTracking([...targets, ...additions]);
    return true;
  }
  trackingTargets(): readonly TrackingTarget[] | undefined {
    return this.initializationConfiguration?.targets;
  }
  owns(uri: vscode.Uri): boolean {
    const value = uri.toString();
    return (
      value.startsWith(`${this.directoryUri.toString()}/`) ||
      value === this.directoryUri.toString() ||
      value.startsWith(`${this.legacyDirectoryUri.toString()}/`) ||
      value === this.legacyDirectoryUri.toString() ||
      value === this.legacyUri.toString() ||
      value === this.legacyBackupUri.toString()
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
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileSystem.fileUri(path));
      const parsed = parseStoredFile(JSON.parse(decoder.decode(bytes)));
      if (parsed === undefined || parsed.path !== path) {
        throw new Error("Invalid v4 per-file review metadata");
      }
      this.summaries.set(path, summarize(parsed.file));
      this.touch(path, parsed.file);
      return parsed.file;
    } catch (error) {
      if (isFileNotFound(error)) {
        this.touch(path, undefined);
        return undefined;
      }
      this.log.warn(
        `Unable to load review metadata for ${path}: ${String(error)}`,
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
          `Deleting unreadable review metadata for ${path}: ${String(error)}`,
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
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.directoryUri);
      const hasData = entries.some(([name, type]) => {
        if (name === INITIALIZATION_FILE) {
          return true;
        }
        if (
          (type & vscode.FileType.File) !== 0 &&
          name.endsWith(".json") &&
          !name.includes(".tmp-")
        ) {
          return true;
        }
        return false;
      });
      if (hasData) {
        return;
      }
    } catch (error) {
      if (!isFileNotFound(error)) {
        this.log.warn(
          `Unable to inspect extension storage before migration: ${String(error)}`,
        );
        return;
      }
    }

    let legacyEntries: readonly [string, vscode.FileType][];
    try {
      legacyEntries = await vscode.workspace.fs.readDirectory(
        this.legacyDirectoryUri,
      );
    } catch (error) {
      if (isFileNotFound(error)) {
        return;
      }
      this.log.warn(`Unable to inspect legacy review storage: ${String(error)}`);
      return;
    }

    const legacyInitUri = vscode.Uri.joinPath(
      this.legacyDirectoryUri,
      INITIALIZATION_FILE,
    );
    let migratedInit = false;
    try {
      const bytes = await vscode.workspace.fs.readFile(legacyInitUri);
      const configuration = parseInitializationConfiguration(
        JSON.parse(decoder.decode(bytes)),
      );
      if (configuration !== undefined) {
        await this.fileSystem.writeInitialization(configuration);
        this.log.info(
          `Migrated legacy initialization from ${this.legacyDirectoryUri.fsPath}`,
        );
        migratedInit = true;
      }
    } catch (error) {
      if (!isFileNotFound(error)) {
        this.log.warn(`Unable to migrate legacy initialization: ${String(error)}`);
      }
    }

    let migrated = 0;
    for (const [name, type] of legacyEntries) {
      if (name === INITIALIZATION_FILE) {
        continue;
      }
      if (
        (type & vscode.FileType.File) === 0 ||
        !name.endsWith(".json") ||
        name.includes(".tmp-")
      ) {
        continue;
      }
      const legacyFileUri = vscode.Uri.joinPath(this.legacyDirectoryUri, name);
      try {
        const bytes = await vscode.workspace.fs.readFile(legacyFileUri);
        const parsed = parseStoredFile(JSON.parse(decoder.decode(bytes)));
        if (parsed === undefined || storageFileName(parsed.path) !== name) {
          continue;
        }
        try {
          await vscode.workspace.fs.stat(this.fileSystem.fileUri(parsed.path));
          continue;
        } catch (statError) {
          if (!isFileNotFound(statError)) {
            throw statError;
          }
        }
        const snapshotName = parsed.file.baseline.file;
        if (snapshotName) {
          const legacySnapshotUri = vscode.Uri.joinPath(
            this.legacySnapshotsUri,
            snapshotName,
          );
          try {
            const compressed = await vscode.workspace.fs.readFile(
              legacySnapshotUri,
            );
            const raw = decodeSnapshot(
              compressed,
              parsed.file.baseline.digest,
              parsed.file.baseline.size,
              parsed.file.baseline.size + 1,
            );
            await this.fileSystem.writeSnapshot(parsed.file, raw);
          } catch (error) {
            if (isFileNotFound(error)) {
              continue;
            }
            this.log.warn(
              `Unable to migrate snapshot ${snapshotName}: ${String(error)}`,
            );
            continue;
          }
        }
        await this.fileSystem.writeJson(parsed.path, parsed.file);
        migrated += 1;
      } catch (error) {
        this.log.warn(
          `Unable to migrate legacy metadata ${name}: ${String(error)}`,
        );
      }
    }
    if (migrated > 0) {
      this.log.info(
        `Migrated ${migrated} legacy review files from ${this.legacyDirectoryUri.fsPath}`,
      );
    } else if (migratedInit) {
      // Initialization already migrated; no files needed.
    }
  }

  private async loadInitialization(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.initializationUri);
      const configuration = parseInitializationConfiguration(
        JSON.parse(decoder.decode(bytes)),
      );
      if (configuration === undefined) {
        throw new Error("Invalid initialization configuration");
      }
      this.initializationConfiguration = configuration;
    } catch (error) {
      if (!isFileNotFound(error)) {
        this.log.warn(
          `Unable to load initialization configuration: ${String(error)}`,
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
        return true;
      }
      this.log.warn(`Unable to scan review metadata: ${String(error)}`);
      return false;
    }
    let valid = true;
    await Promise.all(entries.map(async ([name, type]) => {
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
        const parsed = parseStoredFile(JSON.parse(decoder.decode(bytes)));
        if (parsed === undefined || storageFileName(parsed.path) !== name) {
          throw new Error("Unsupported or malformed metadata");
        }
        this.summaries.set(parsed.path, summarize(parsed.file));
      } catch (error) {
        valid = false;
        this.log.warn(`Ignoring metadata file ${name}: ${String(error)}`);
      }
    }));
    return valid;
  }
  private async cleanupSnapshots(): Promise<void> {
    let entries: readonly [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.snapshotsUri);
    } catch (error) {
      if (!isFileNotFound(error)) {
        this.log.warn(`Unable to clean snapshots: ${String(error)}`);
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
      const parsed = parseStoredFile(JSON.parse(decoder.decode(bytes)));
      if (parsed === undefined || parsed.path !== path) {
        throw new Error("Invalid v4 per-file review metadata");
      }
      return parsed.file;
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


