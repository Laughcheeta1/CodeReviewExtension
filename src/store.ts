import * as vscode from "vscode";
import { fileStatus, type FileRecord } from "./domain";
import {  // RevExt: 197
  parseStoredFile,
  storageFileName,
  summarize,
  type FileSummary,
} from "./storage-format";
import { decodeSnapshot } from "./snapshot";
import {  // RevExt: 198
  parseInitializationConfiguration,
  tracksPath,
  type InitializationConfiguration,
  type TrackingTarget,
} from "./tracking";
import { StoreFileSystem } from "./store-io";
const decoder = new TextDecoder("utf-8", { fatal: true });
const CACHE_LIMIT = 8;
const INITIALIZATION_FILE = "initialization.json";
// RevExt: 195
export class PersistentStore {
  private readonly summaries = new Map<string, FileSummary>();
  private readonly cache = new Map<string, FileRecord | undefined>();
  private readonly loadTails = new Map<string, Promise<FileRecord | undefined>>();
  private readonly writeTails = new Map<string, Promise<void>>();
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
      folder.uri,  // RevExt: 1
      ".vscode",  // RevExt: 4
      "code-review-tracker",
    );  // RevExt: 7
    this.snapshotsUri = vscode.Uri.joinPath(this.directoryUri, "snapshots");
    this.initializationUri = vscode.Uri.joinPath(
      this.directoryUri,  // RevExt: 202
      INITIALIZATION_FILE,
    );  // RevExt: 200
    this.fileSystem = new StoreFileSystem(
      this.directoryUri,
      this.snapshotsUri,
      this.initializationUri,
      this.log,
    );
    this.legacyUri = vscode.Uri.joinPath(
      folder.uri,  // RevExt: 2
      ".vscode",  // RevExt: 5
      "code-review-tracker.json",
    );  // RevExt: 8
    this.legacyBackupUri = vscode.Uri.joinPath(
      folder.uri,  // RevExt: 3
      ".vscode",  // RevExt: 6
      "code-review-tracker.v1.migrated.json",
    );  // RevExt: 9
  }  // RevExt: 15
  get paths(): readonly string[] {
    return [...this.summaries.keys()];
  }  // RevExt: 16
  get hasMetadata(): boolean {
    return this.summaries.size > 0;
  }  // RevExt: 17
  get initializationState(): "unconfigured" | "disabled" | "initialized" {
    return this.initializationConfiguration?.state ?? "unconfigured";
  }  // RevExt: 205
  async initialize(): Promise<void> {
    await this.loadInitialization();
    const safeToClean = await this.loadSummaries();
    if (this.initializationConfiguration === undefined && this.hasMetadata) {
      this.initializationConfiguration = {
        schemaVersion: 1,
        state: "initialized",
        targets: [{ kind: "folder", path: "" }],
      };
    }  // RevExt: 212
    if (safeToClean) {
      await this.cleanupSnapshots();
    }  // RevExt: 38
  }  // RevExt: 18
  tracksPath(path: string): boolean {
    return tracksPath(path, this.initializationConfiguration);
  }  // RevExt: 206
  async disableTracking(): Promise<void> {
    const configuration = { schemaVersion: 1, state: "disabled" } as const;
    await this.fileSystem.writeInitialization(configuration);
    this.initializationConfiguration = configuration;
  }  // RevExt: 207
  async enableTracking(targets: readonly TrackingTarget[]): Promise<void> {
    const configuration = {
      schemaVersion: 1,
      state: "initialized",
      targets,
    } as const;
    await this.fileSystem.writeInitialization(configuration);
    this.initializationConfiguration = configuration;
  }  // RevExt: 208
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
  }  // RevExt: 209
  owns(uri: vscode.Uri): boolean {
    const value = uri.toString();
    return (
      value.startsWith(`${this.directoryUri.toString()}/`) ||
      value === this.directoryUri.toString() ||
      value === this.legacyUri.toString() ||
      value === this.legacyBackupUri.toString()
    );  // RevExt: 10
  }  // RevExt: 19
  peek(path: string): FileRecord | undefined {
    const file = this.cache.get(path);
    if (this.cache.has(path)) {  // RevExt: 57
      this.touch(path, file);
    }  // RevExt: 39
    return file;
  }  // RevExt: 20
  hasLoaded(path: string): boolean {
    return this.cache.has(path);
  }  // RevExt: 21
  summary(path: string): FileSummary | undefined {
    return this.summaries.get(path);
  }  // RevExt: 22
  async load(path: string): Promise<FileRecord | undefined> {
    if (this.cache.has(path)) {  // RevExt: 58
      return this.peek(path);
    }  // RevExt: 40
    const previous = this.loadTails.get(path);
    if (previous !== undefined) {
      return previous;
    }
    const current = this.loadUncached(path);
    this.loadTails.set(path, current);
    try {
      return await current;
    } finally {
      if (this.loadTails.get(path) === current) {
        this.loadTails.delete(path);
      }
    }
  }
  private async loadUncached(path: string): Promise<FileRecord | undefined> {
    try {  // RevExt: 59
      const bytes = await vscode.workspace.fs.readFile(this.fileSystem.fileUri(path));  // RevExt: 70
      const parsed = parseStoredFile(JSON.parse(decoder.decode(bytes)));  // RevExt: 72
      if (parsed === undefined || parsed.path !== path) {  // RevExt: 74
        throw new Error("Invalid v4 per-file review metadata");  // RevExt: 76
      }  // RevExt: 78
      this.summaries.set(path, summarize(parsed.file));
      this.touch(path, parsed.file);
      return parsed.file;  // RevExt: 101
    } catch (error) {  // RevExt: 103
      if (isFileNotFound(error)) {  // RevExt: 111
        this.touch(path, undefined);
        return undefined;  // RevExt: 114
      }  // RevExt: 79
      this.log.warn(
        `Unable to load review metadata for ${path}: ${String(error)}`,
      );  // RevExt: 116
      throw error;  // RevExt: 120
    }  // RevExt: 41
  }  // RevExt: 23
  async loadBaseline(file: FileRecord, maxSize: number): Promise<Uint8Array> {
    const snapshot = vscode.Uri.joinPath(this.snapshotsUri, file.baseline.file);
    const compressed = await vscode.workspace.fs.readFile(snapshot);
    return decodeSnapshot(
      compressed,
      file.baseline.digest,
      file.baseline.size,
      maxSize,
    );  // RevExt: 11
  }  // RevExt: 24
  async commit(
    path: string,  // RevExt: 122
    file: FileRecord,  // RevExt: 124
    baselineBytes?: Uint8Array,
  ): Promise<void> {  // RevExt: 126
    const normalized = { ...file, fileStatus: fileStatus(file) };
    await this.enqueue(path, async () => {  // RevExt: 129
      const previous = this.cache.has(path)
        ? this.cache.get(path)
        : await this.loadDirect(path);
      if (baselineBytes !== undefined) {
        await this.fileSystem.writeSnapshot(normalized, baselineBytes);
      }  // RevExt: 80
      await this.fileSystem.writeJson(path, normalized);
      this.summaries.set(path, summarize(normalized));
      this.touch(path, normalized);
      if (  // RevExt: 131
        previous !== undefined &&
        previous.baseline.file !== normalized.baseline.file
      ) {  // RevExt: 133
        await this.fileSystem.deleteSnapshot(previous.baseline.file);  // RevExt: 135
      }  // RevExt: 81
    });  // RevExt: 137
  }  // RevExt: 25
  async delete(path: string): Promise<void> {
    await this.enqueue(path, async () => {  // RevExt: 130
      let previous: FileRecord | undefined;
      try {  // RevExt: 139
        previous = await this.loadDirect(path);
      } catch (error) {  // RevExt: 143
        this.log.warn(  // RevExt: 147
          `Deleting unreadable review metadata for ${path}: ${String(error)}`,
        );  // RevExt: 149
      }  // RevExt: 82
      try {  // RevExt: 140
      await vscode.workspace.fs.delete(this.fileSystem.fileUri(path), {
          useTrash: false,
        });
      } catch (error) {  // RevExt: 144
        if (!isFileNotFound(error)) {  // RevExt: 152
          throw error;  // RevExt: 154
        }  // RevExt: 156
      }  // RevExt: 83
      if (previous !== undefined) {
        await this.fileSystem.deleteSnapshot(previous.baseline.file);  // RevExt: 136
      }  // RevExt: 84
      this.summaries.delete(path);
      this.cache.delete(path);
    });  // RevExt: 138
  }  // RevExt: 26
  async reset(): Promise<void> {
    const initializationConfiguration = this.initializationConfiguration;
    await Promise.allSettled(this.writeTails.values());
    try {  // RevExt: 60
      await vscode.workspace.fs.delete(this.directoryUri, {
        recursive: true,
        useTrash: false,
      });  // RevExt: 159
    } catch (error) {  // RevExt: 104
      if (!isFileNotFound(error)) {  // RevExt: 162
        throw error;  // RevExt: 167
      }  // RevExt: 85
    }  // RevExt: 42
    for (const legacy of [this.legacyUri, this.legacyBackupUri]) {
      try {  // RevExt: 141
        await vscode.workspace.fs.delete(legacy, { useTrash: false });
      } catch (error) {  // RevExt: 145
        if (!isFileNotFound(error)) {  // RevExt: 153
          throw error;  // RevExt: 155
        }  // RevExt: 157
      }  // RevExt: 86
    }  // RevExt: 43
    this.summaries.clear();
    this.cache.clear();
    this.loadTails.clear();
    this.writeTails.clear();
    if (initializationConfiguration !== undefined) {
      await this.fileSystem.writeInitialization(initializationConfiguration);
      this.initializationConfiguration = initializationConfiguration;
    }  // RevExt: 213
  }  // RevExt: 27
  private async loadInitialization(): Promise<void> {
    try {  // RevExt: 217
      const bytes = await vscode.workspace.fs.readFile(this.initializationUri);
      const configuration = parseInitializationConfiguration(
        JSON.parse(decoder.decode(bytes)),
      );  // RevExt: 223
      if (configuration === undefined) {
        throw new Error("Invalid initialization configuration");
      }  // RevExt: 219
      this.initializationConfiguration = configuration;  // RevExt: 229
    } catch (error) {  // RevExt: 222
      if (!isFileNotFound(error)) {  // RevExt: 228
        this.log.warn(  // RevExt: 225
          `Unable to load initialization configuration: ${String(error)}`,
        );  // RevExt: 226
      }  // RevExt: 220
    }  // RevExt: 214
  }  // RevExt: 210
  private async loadSummaries(): Promise<boolean> {
    let entries: readonly [string, vscode.FileType][];  // RevExt: 169
    try {  // RevExt: 61
      entries = await vscode.workspace.fs.readDirectory(this.directoryUri);
    } catch (error) {  // RevExt: 105
      if (isFileNotFound(error)) {  // RevExt: 112
        return true;
      }  // RevExt: 87
      this.log.warn(`Unable to scan review metadata: ${String(error)}`);
      return false;
    }  // RevExt: 44
    let valid = true;
    await Promise.all(entries.map(async ([name, type]) => {  // RevExt: 171
      if (name === INITIALIZATION_FILE) {
        return;  // RevExt: 231
      }  // RevExt: 221
      if ((type & vscode.FileType.File) !== 0 && name.includes(".tmp-")) {
        await this.fileSystem.deleteTemporary(
          vscode.Uri.joinPath(this.directoryUri, name),
        );  // RevExt: 150
        return;  // RevExt: 173
      }  // RevExt: 88
      if ((type & vscode.FileType.File) === 0 || !name.endsWith(".json")) {
        return;  // RevExt: 174
      }  // RevExt: 89
      try {  // RevExt: 142
        const metadata = vscode.Uri.joinPath(this.directoryUri, name);
        const bytes = await vscode.workspace.fs.readFile(metadata);
        const parsed = parseStoredFile(JSON.parse(decoder.decode(bytes)));
        if (parsed === undefined || storageFileName(parsed.path) !== name) {
          throw new Error("Unsupported or malformed metadata");
        }  // RevExt: 158
        this.summaries.set(parsed.path, summarize(parsed.file));
      } catch (error) {  // RevExt: 146
        valid = false;
        this.log.warn(`Ignoring metadata file ${name}: ${String(error)}`);
      }  // RevExt: 90
    }));  // RevExt: 45
    return valid;
  }  // RevExt: 28
  private async cleanupSnapshots(): Promise<void> {
    let entries: readonly [string, vscode.FileType][];  // RevExt: 170
    try {  // RevExt: 62
      entries = await vscode.workspace.fs.readDirectory(this.snapshotsUri);
    } catch (error) {  // RevExt: 106
      if (!isFileNotFound(error)) {  // RevExt: 163
        this.log.warn(`Unable to clean snapshots: ${String(error)}`);
      }  // RevExt: 91
      return;  // RevExt: 176
    }  // RevExt: 46
    const referenced = new Set(
      [...this.summaries.values()].map((summary) => summary.baselineFile),
    );  // RevExt: 12
    for (const [name, type] of entries) {  // RevExt: 172
      if ((type & vscode.FileType.File) === 0) {
        continue;  // RevExt: 175
      }  // RevExt: 92
      if (  // RevExt: 132
        name.includes(".tmp-") ||
        (name.endsWith(".gz") && !referenced.has(name))
      ) {  // RevExt: 134
        await this.fileSystem.deleteSnapshot(name);
      }  // RevExt: 93
    }  // RevExt: 47
  }  // RevExt: 29
  private async loadDirect(path: string): Promise<FileRecord | undefined> {
    try {  // RevExt: 66
      const bytes = await vscode.workspace.fs.readFile(this.fileSystem.fileUri(path));  // RevExt: 71
      const parsed = parseStoredFile(JSON.parse(decoder.decode(bytes)));  // RevExt: 73
      if (parsed === undefined || parsed.path !== path) {  // RevExt: 75
        throw new Error("Invalid v4 per-file review metadata");  // RevExt: 77
      }  // RevExt: 95
      return parsed.file;  // RevExt: 102
    } catch (error) {  // RevExt: 108
      if (isFileNotFound(error)) {  // RevExt: 113
        return undefined;  // RevExt: 115
      }  // RevExt: 96
      throw error;  // RevExt: 121
    }  // RevExt: 52
  }  // RevExt: 32
  private touch(path: string, file: FileRecord | undefined): void {
    this.cache.delete(path);
    this.cache.set(path, file);
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }  // RevExt: 98
      this.cache.delete(oldest);
    }  // RevExt: 54
  }  // RevExt: 35
  private async enqueue(
    path: string,  // RevExt: 123
    operation: () => Promise<void>,
  ): Promise<void> {  // RevExt: 128
    const previous = this.writeTails.get(path) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.writeTails.set(path, current);
    try {  // RevExt: 68
      await current;
    } finally {  // RevExt: 190
      if (this.writeTails.get(path) === current) {
        this.writeTails.delete(path);
      }  // RevExt: 99
    }  // RevExt: 55
  }  // RevExt: 36
}  // RevExt: 193
function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError && error.code === "FileNotFound"
  );
}  // RevExt: 194
// RevExt: 196
// RevExt: 199
