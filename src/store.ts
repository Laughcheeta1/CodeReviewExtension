import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { digestBytes, fileStatus, type FileRecord } from './domain';
import { parseStoredFile, storageFileName, storedFile, summarize, type FileSummary } from './storage-format';
import { decodeSnapshot, encodeSnapshot } from './snapshot';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const CACHE_LIMIT = 8;
export class PersistentStore {
    private readonly summaries = new Map<string, FileSummary>();
    private readonly cache = new Map<string, FileRecord | undefined>();
    private readonly writeTails = new Map<string, Promise<void>>();
    private readonly directoryUri: vscode.Uri;
    private readonly snapshotsUri: vscode.Uri;
    private readonly legacyUri: vscode.Uri;
    private readonly legacyBackupUri: vscode.Uri;
    constructor(private readonly folder: vscode.WorkspaceFolder, private readonly log: vscode.LogOutputChannel) {
        this.directoryUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'code-review-tracker');
        this.snapshotsUri = vscode.Uri.joinPath(this.directoryUri, 'snapshots');
        this.legacyUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'code-review-tracker.json');
        this.legacyBackupUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'code-review-tracker.v1.migrated.json');
    }
    get paths(): readonly string[] { return [...this.summaries.keys()]; }
    get hasMetadata(): boolean { return this.summaries.size > 0; }
    async initialize(): Promise<void> {
        const safeToClean = await this.loadSummaries();
        if (safeToClean) {
            await this.cleanupSnapshots();
        }
    }
    owns(uri: vscode.Uri): boolean {
        const value = uri.toString();
        return value.startsWith(`${this.directoryUri.toString()}/`) || value === this.directoryUri.toString()
            || value === this.legacyUri.toString() || value === this.legacyBackupUri.toString();
    }
    peek(path: string): FileRecord | undefined {
        const file = this.cache.get(path);
        if (this.cache.has(path)) {
            this.touch(path, file);
        }
        return file;
    }
    hasLoaded(path: string): boolean { return this.cache.has(path); }
    summary(path: string): FileSummary | undefined { return this.summaries.get(path); }
    async load(path: string): Promise<FileRecord | undefined> {
        if (this.cache.has(path)) {
            return this.peek(path);
        }
        try {
            const parsed = parseStoredFile(JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(this.fileUri(path)))));
            if (parsed === undefined || parsed.path !== path) {
                throw new Error('Invalid v4 per-file review metadata');
            }
            this.summaries.set(path, summarize(parsed.file));
            this.touch(path, parsed.file);
            return parsed.file;
        } catch (error) {
            if (isFileNotFound(error)) {
                this.touch(path, undefined);
                return undefined;
            }
            this.log.warn(`Unable to load review metadata for ${path}: ${String(error)}`);
            throw error;
        }
    }
    async loadBaseline(file: FileRecord, maxSize: number): Promise<Uint8Array> {
        const compressed = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.snapshotsUri, file.baseline.file));
        return decodeSnapshot(compressed, file.baseline.digest, file.baseline.size, maxSize);
    }
    async commit(path: string, file: FileRecord, baselineBytes?: Uint8Array): Promise<void> {
        const normalized = { ...file, fileStatus: fileStatus(file) };
        await this.enqueue(path, async () => {
            const previous = await this.loadDirect(path);
            if (baselineBytes !== undefined) {
                await this.writeSnapshot(normalized, baselineBytes);
            }
            await this.writeJson(path, normalized);
            this.summaries.set(path, summarize(normalized));
            this.touch(path, normalized);
            if (previous !== undefined && previous.baseline.file !== normalized.baseline.file) {
                await this.deleteSnapshot(previous.baseline.file);
            }
        });
    }
    async delete(path: string): Promise<void> {
        await this.enqueue(path, async () => {
            let previous: FileRecord | undefined;
            try {
                previous = await this.loadDirect(path);
            } catch (error) {
                this.log.warn(`Deleting unreadable review metadata for ${path}: ${String(error)}`);
            }
            try {
                await vscode.workspace.fs.delete(this.fileUri(path), { useTrash: false });
            } catch (error) {
                if (!isFileNotFound(error)) {
                    throw error;
                }
            }
            if (previous !== undefined) {
                await this.deleteSnapshot(previous.baseline.file);
            }
            this.summaries.delete(path);
            this.cache.delete(path);
        });
    }
    async reset(): Promise<void> {
        await Promise.allSettled(this.writeTails.values());
        try {
            await vscode.workspace.fs.delete(this.directoryUri, { recursive: true, useTrash: false });
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
        this.writeTails.clear();
    }
    private async loadSummaries(): Promise<boolean> {
        let entries: readonly [
            string,
            vscode.FileType
        ][];
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
        for (const [name, type] of entries) {
            if ((type & vscode.FileType.File) !== 0 && name.includes('.tmp-')) {
                await this.deleteTemporary(vscode.Uri.joinPath(this.directoryUri, name));
                continue;
            }
            if ((type & vscode.FileType.File) === 0 || !name.endsWith('.json')) {
                continue;
            }
            try {
                const parsed = parseStoredFile(JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.directoryUri, name)))));
                if (parsed === undefined || storageFileName(parsed.path) !== name) {
                    throw new Error('Unsupported or malformed metadata');
                }
                this.summaries.set(parsed.path, summarize(parsed.file));
            } catch (error) {
                valid = false;
                this.log.warn(`Ignoring metadata file ${name}: ${String(error)}`);
            }
        }
        return valid;
    }
    private async cleanupSnapshots(): Promise<void> {
        let entries: readonly [
            string,
            vscode.FileType
        ][];
        try {
            entries = await vscode.workspace.fs.readDirectory(this.snapshotsUri);
        } catch (error) {
            if (!isFileNotFound(error)) {
                this.log.warn(`Unable to clean snapshots: ${String(error)}`);
            }
            return;
        }
        const referenced = new Set([...this.summaries.values()].map(summary => summary.baselineFile));
        for (const [name, type] of entries) {
            if ((type & vscode.FileType.File) === 0) {
                continue;
            }
            if (name.includes('.tmp-') || (name.endsWith('.gz') && !referenced.has(name))) {
                await this.deleteSnapshot(name);
            }
        }
    }
    private async writeSnapshot(file: FileRecord, bytes: Uint8Array): Promise<void> {
        if (bytes.byteLength !== file.baseline.size || digestBytes(bytes) !== file.baseline.digest) {
            throw new Error('Snapshot bytes do not match the baseline descriptor');
        }
        await vscode.workspace.fs.createDirectory(this.snapshotsUri);
        const target = vscode.Uri.joinPath(this.snapshotsUri, file.baseline.file);
        try {
            const existing = await vscode.workspace.fs.readFile(target);
            decodeSnapshot(existing, file.baseline.digest, file.baseline.size, file.baseline.size + 1);
            return;
        } catch (error) {
            if (!isFileNotFound(error)) {
                throw error;
            }
        }
        const temporary = vscode.Uri.joinPath(this.snapshotsUri, `${file.baseline.file}.tmp-${randomUUID()}`);
        try {
            await vscode.workspace.fs.writeFile(temporary, encodeSnapshot(bytes));
            decodeSnapshot(await vscode.workspace.fs.readFile(temporary), file.baseline.digest, file.baseline.size, file.baseline.size + 1);
            await vscode.workspace.fs.rename(temporary, target, { overwrite: false });
        } finally {
            await this.deleteTemporary(temporary);
        }
    }
    private async writeJson(path: string, file: FileRecord): Promise<void> {
        await vscode.workspace.fs.createDirectory(this.directoryUri);
        const temporary = vscode.Uri.joinPath(this.directoryUri, `.${storageFileName(path)}.tmp-${randomUUID()}`);
        try {
            await vscode.workspace.fs.writeFile(temporary, encoder.encode(`${JSON.stringify(storedFile(path, file), null, 2)}\n`));
            await vscode.workspace.fs.rename(temporary, this.fileUri(path), { overwrite: true });
        } finally {
            await this.deleteTemporary(temporary);
        }
    }
    private async loadDirect(path: string): Promise<FileRecord | undefined> {
        try {
            const parsed = parseStoredFile(JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(this.fileUri(path)))));
            if (parsed === undefined || parsed.path !== path) {
                throw new Error('Invalid v4 per-file review metadata');
            }
            return parsed.file;
        } catch (error) {
            if (isFileNotFound(error)) {
                return undefined;
            }
            throw error;
        }
    }
    private async deleteSnapshot(name: string): Promise<void> {
        try {
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.snapshotsUri, name), { useTrash: false });
        } catch (error) {
            if (!isFileNotFound(error)) {
                this.log.warn(`Unable to remove snapshot ${name}: ${String(error)}`);
            }
        }
    }
    private fileUri(path: string): vscode.Uri { return vscode.Uri.joinPath(this.directoryUri, storageFileName(path)); }
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
    private async enqueue(path: string, operation: () => Promise<void>): Promise<void> {
        const previous = this.writeTails.get(path) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(operation);
        this.writeTails.set(path, current);
        try {
            await current;
        } finally {
            if (this.writeTails.get(path) === current) {
                this.writeTails.delete(path);
            }
        }
    }
    private async deleteTemporary(uri: vscode.Uri): Promise<void> {
        try {
            await vscode.workspace.fs.delete(uri, { useTrash: false });
        } catch (error) {
            if (!isFileNotFound(error)) {
                this.log.warn(`Unable to remove temporary file ${uri.path}: ${String(error)}`);
            }
        }
    }
}
function isFileNotFound(error: unknown): boolean { return error instanceof vscode.FileSystemError && error.code === 'FileNotFound'; }

