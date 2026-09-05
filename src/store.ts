import * as vscode from "vscode";
import { fileStatus, type FileRecord } from "./domain";
import { coalesced, serialized } from "./concurrency";
import {
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

export class PersistentStore {
  private readonly summaries = new Map<string, FileSummary>();
  private readonly cache = new Map<string, FileRecord | undefined>();
  private readonly loadTails = new Map<string, Promise<FileRecord | undefined>>();
  private readonly writeTails = new Map<string, Promise<unknown>>();
  private readonly directoryUri: vscode.Uri;
  private readonly snapshotsUri: vscode.Uri;
  private readonly initializationUri: vscode.Uri;
  private readonly fileSystem: StoreFileSystem;
  private readonly legacyUri: vscode.Uri;
  private readonly legacyBackupUri: vscode.Uri;
  private initializationConfiguration: InitializationConfiguration | undefined;
  constructor(
    private readonly folder: vscode.WorkspaceFolder,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.directoryUri = vscode.Uri.joinPath(
      folder.uri,
      ".vscode",
      "code-review-tracker",
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


