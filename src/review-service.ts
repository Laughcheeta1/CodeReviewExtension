import * as vscode from 'vscode';
import {
    buildDiffRecords,
    digestBytes,
    fileStatus,
    physicalLines,
    reviewableLines,
    setReviewer,
    type FileRecord,
    type ReviewStatus,
    type Reviewer,
    type SourceSnapshot
} from './domain';
import { GitService } from './git';
import { PersistentStore } from './store';
import { snapshotFileName, sourceMayHaveChanged } from './storage-format';
import { revExtEdits, revExtRemovals } from './revext';
const BASELINE_SCHEME = 'code-review-baseline';
const now = (): string => new Date().toISOString();

interface BaselineIdentity {
    readonly source: vscode.Uri;
    readonly baselineDigest: string;
    readonly currentDigest: string;
}
export class ReviewService implements vscode.Disposable {
    private readonly stores = new Map<string, PersistentStore>();
    private readonly eligiblePaths = new Map<string, Set<string>>();
    private readonly sourceTails = new Map<string, Promise<void>>();
    private readonly initializingFolders = new Set<string>();
    private readonly internalSaves = new Set<string>();
    private readonly changedEmitter = new vscode.EventEmitter<vscode.Uri | undefined>();
    readonly onDidChange = this.changedEmitter.event;
    private readonly promotedEmitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidPromote = this.promotedEmitter.event;
    constructor(
        private readonly log: vscode.LogOutputChannel,
        private readonly git: GitService
    ) { }

    async initialize(): Promise<void> {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const store = new PersistentStore(folder, this.log);
            await store.initialize();
            this.stores.set(folder.uri.toString(), store);
        }
    }
    hasMetadata(folder: vscode.WorkspaceFolder): boolean {
        return this.stores.get(folder.uri.toString())?.hasMetadata ?? false;
    }

    dispose(): void {
        this.changedEmitter.dispose();
        this.promotedEmitter.dispose();
    }
    setEligiblePaths(folder: vscode.WorkspaceFolder, paths: readonly string[]): void {
        const key = folder.uri.toString();
        const next = new Set(paths);
        const previous = this.eligiblePaths.get(key);
        this.eligiblePaths.set(key, next);
        if (previous === undefined || previous.size !== next.size || [...previous].some(path => !next.has(path))) {
            this.changedEmitter.fire(undefined);
        }
    }
    relativePath(uri: vscode.Uri): string | undefined {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        return folder === undefined ? undefined : vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
    }
    isTrackable(document: vscode.TextDocument): boolean { return this.isTrackableUri(document.uri); }
    isBaseline(uri: vscode.Uri): boolean { return uri.scheme === BASELINE_SCHEME; }
    file(uri: vscode.Uri): FileRecord | undefined {
        const source = this.isBaseline(uri) ? this.parseBaselineUri(uri)?.source : uri;
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
        try {
            await this.withSource(document.uri, async () => {
                if (store.hasLoaded(path)) {
                    return;
                }
                await store.load(path);
                this.changedEmitter.fire(document.uri);
            });
        } catch { /* The store logged read failures; initialization intentionally blocks this load. */ }
    }
    async reconcileExternalChanges(folder: vscode.WorkspaceFolder, force = false): Promise<void> {
        const store = this.stores.get(folder.uri.toString());
        if (store === undefined) {
            return;
        }
        const eligible = this.eligiblePaths.get(folder.uri.toString());
        let changed = 0;
        let removed = 0;
        const paths = store.hasMetadata ? new Set([...store.paths, ...(eligible ?? [])]) : new Set(store.paths);
        for (const path of paths) {
            const uri = vscode.Uri.joinPath(folder.uri, ...path.split('/'));
            try {
                if (await this.withSource(uri, () => this.recompute(uri, force, true))) {
                    changed += 1;
                }
            } catch (error) {
                if (!isFileNotFound(error)) {
                    this.log.warn(
                        `Review recomputation failed for ${path}; existing state was preserved: ${String(error)}`
                    );
                    continue;
                }
                await this.withSource(uri, () => store.delete(path));
                eligible?.delete(path);
                removed += 1;
            }
        }
        if (changed > 0 || removed > 0) {
            this.log.info(`Review reconciliation updated ${changed} and removed ${removed} files.`);
            this.changedEmitter.fire(undefined);
        }
    }
    async reconcileSavedDocument(document: vscode.TextDocument): Promise<void> {
        if (document.uri.scheme !== 'file') {
            return;
        }
        const internalKey = document.uri.toString();
        if (this.internalSaves.delete(internalKey)) {
            return;
        }
        const store = this.storeFor(document.uri);
        const path = this.relativePath(document.uri);
        if (store === undefined || path === undefined || !this.isEligibleSourceUri(document.uri) || !store.hasMetadata) {
            return;
        }
        this.eligiblePaths.get(vscode.workspace.getWorkspaceFolder(document.uri)!.uri.toString())?.add(path);
        try {
            await this.withSource(document.uri, () => this.recomputeSavedDocument(document));
            this.changedEmitter.fire(document.uri);
        } catch (error) {
            this.log.warn(
                `Could not reconcile saved source ${this.relativePath(document.uri) ?? document.uri.toString()}: ${String(error)}`
            );
        }
    }
    async initializeFolder(folder: vscode.WorkspaceFolder, status: 'pending' | 'reviewed'): Promise<void> {
        const store = this.stores.get(folder.uri.toString());
        if (store === undefined) {
            return;
        }
        const eligible = this.eligiblePaths.get(folder.uri.toString());
        if (eligible === undefined) {
            throw new Error('Workspace files have not been enumerated.');
        }
        const folderKey = folder.uri.toString();
        if (this.initializingFolders.has(folderKey)) {
            throw new Error('This workspace is already being initialized.');
        }
        this.initializingFolders.add(folderKey);
        try {
            await Promise.allSettled(this.sourceTails.values());
            await store.reset();
            const maxSize = this.maxSize();
            const paths = [...eligible].sort();
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Code Review: start ${status}`
                },
                async progress => {
                for (let index = 0; index < paths.length; index += 1) {
                    const path = paths[index]!;
                    const uri = vscode.Uri.joinPath(folder.uri, ...path.split('/'));
                    try {
                        if (!this.isTrackableUri(uri)) {
                            continue;
                        }
                        const { bytes, source } = await this.readStableSource(uri, maxSize);
                        const baseline = status === 'reviewed' ? bytes : new Uint8Array();
                        const file = await this.createRecord(path, baseline, bytes, source, status === 'reviewed' ? now() : undefined);
                        await store.commit(path, file, baseline);
                    } catch (error) {
                        this.log.warn(`Skipping ${path}: ${String(error)}`);
                    }
                    progress.report({ increment: 100 / Math.max(paths.length, 1) });
                }
                }
            );
            this.changedEmitter.fire(undefined);
        } finally {
            this.initializingFolders.delete(folderKey);
        }
    }
    baselineUri(source: vscode.Uri, file: FileRecord): vscode.Uri {
        return vscode.Uri.from({
            scheme: BASELINE_SCHEME, path: source.path,
            query: new URLSearchParams({
                source: source.toString(),
                baseline: file.baseline.digest,
                current: file.current.digest
            }).toString()
        });
    }
    parseBaselineUri(uri: vscode.Uri): BaselineIdentity | undefined {
        if (!this.isBaseline(uri)) {
            return undefined;
        }
        const query = new URLSearchParams(uri.query);
        const source = query.get('source');
        const baselineDigest = query.get('baseline');
        const currentDigest = query.get('current');
        if (source === null || baselineDigest === null || currentDigest === null) {
            return undefined;
        }
        return { source: vscode.Uri.parse(source), baselineDigest, currentDigest };
    }
    async baselineContent(uri: vscode.Uri): Promise<string> {
        const identity = this.parseBaselineUri(uri);
        if (identity === undefined) {
            throw new Error('Invalid baseline URI');
        }
        return this.withSource(identity.source, async () => {
            const file = await this.requireFresh(identity.source, identity);
            const store = this.storeFor(identity.source);
            if (store === undefined) {
                throw new Error('Baseline workspace is unavailable');
            }
            return new TextDecoder('utf-8', { fatal: true }).decode(await store.loadBaseline(file, this.maxSize()));
        });
    }
    async prepareDiff(source: vscode.Uri): Promise<{
        baseline: vscode.Uri;
        file: FileRecord;
    } | undefined> {
        return this.withSource(source, async () => {
            if (this.dirtyDocument(source) !== undefined) {
                throw new Error('Save the file before opening its review diff.');
            }
            await this.recompute(source, true);
            const path = this.relativePath(source);
            const store = this.storeFor(source);
            const file = path === undefined ? undefined : await store?.load(path);
            return file === undefined ? undefined : { baseline: this.baselineUri(source, file), file };
        });
    }
    async markEditor(editor: vscode.TextEditor, status: ReviewStatus, reviewer?: Reviewer): Promise<boolean> {
        const identity = this.parseBaselineUri(editor.document.uri);
        const source = identity?.source ?? editor.document.uri;
        const selected = selectedLines(editor.selections);
        return this.withSource(source, async () => {
            if (this.dirtyDocument(source) !== undefined) {
                throw new Error('Save the file before changing review state.');
            }
            const file = await this.requireFresh(source, identity);
            return this.applyReview(source, file, status, reviewer, line => identity === undefined && line.changeType !== 'unchanged' && selected.has(line.line), line => identity !== undefined && selected.has(line.baselineLine));
        });
    }
    async markHunk(source: vscode.Uri, baselineDigest: string, currentDigest: string, hunkIndex: number, status: ReviewStatus, reviewer?: Reviewer): Promise<void> {
        await this.withSource(source, async () => {
            if (this.dirtyDocument(source) !== undefined) {
                throw new Error('Save the file before changing review state.');
            }
            const file = await this.requireFresh(source, { source, baselineDigest, currentDigest });
            const hunk = file.hunks[hunkIndex];
            if (hunk === undefined) {
                throw new Error('The selected review hunk is stale.');
            }
            await this.applyReview(source, file, status, reviewer, line => line.changeType === 'added' && inRange(line.line, hunk.newStart, hunk.newCount), line => inRange(line.baselineLine, hunk.oldStart, hunk.oldCount));
        });
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
        for (const workspaceFolder of folder === undefined ? (vscode.workspace.workspaceFolders ?? []) : [folder]) {
            const store = this.stores.get(workspaceFolder.uri.toString());
            if (store === undefined) {
                continue;
            }
            for (const path of store.paths) {
                const summary = store.summary(path);
                if (summary === undefined) {
                    continue;
                }
                result.push({ uri: vscode.Uri.joinPath(workspaceFolder.uri, ...path.split('/')), path, status: summary.status, reviewed: summary.reviewed, total: summary.total });
            }
        }
        return result;
    }
    async removeSources(uris: readonly vscode.Uri[]): Promise<void> {
        let changed = false;
        for (const uri of uris) {
            const store = this.storeFor(uri);
            if (store === undefined || store.owns(uri)) {
                continue;
            }
            const path = this.relativePath(uri);
            if (path === undefined) {
                continue;
            }
            await this.withSource(uri, () => store.delete(path));
            this.eligiblePaths.get(vscode.workspace.getWorkspaceFolder(uri)!.uri.toString())?.delete(path);
            changed = true;
        }
        if (changed) {
            this.changedEmitter.fire(undefined);
        }
    }
    private async recompute(uri: vscode.Uri, forceDigest: boolean, createMissing = false): Promise<boolean> {
        const path = this.relativePath(uri);
        const store = this.storeFor(uri);
        if (path === undefined || store === undefined) {
            return false;
        }
        const existing = await store.load(path);
        if (existing === undefined) {
            if (!createMissing) {
                return false;
            }
            const { bytes, source } = await this.readStableSource(uri, this.maxSize());
            const baseline = new Uint8Array();
            await store.commit(path, await this.createRecord(path, baseline, bytes, source), baseline);
            return true;
        }
        const stat = await vscode.workspace.fs.stat(uri);
        if (!forceDigest && !sourceMayHaveChanged(stat.mtime, stat.size, existing.current)) {
            return false;
        }
        const { bytes, source } = await this.readStableSource(uri, this.maxSize());
        const digest = digestBytes(bytes);
        if (digest === existing.current.digest) {
            if (source.modifiedAt === existing.current.modifiedAt && source.size === existing.current.size) {
                return false;
            }
            await store.commit(path, { ...existing, current: { ...existing.current, ...source }, updatedAt: now() });
            return true;
        }
        const baseline = await store.loadBaseline(existing, this.maxSize());
        const rawHunks = await this.git.diff(baseline, bytes);
        const diff = buildDiffRecords(baseline, bytes, rawHunks, existing);
        await store.commit(path, {
            ...existing, ...diff,
            current: { digest, ...source, gitAlgorithm: 'myers', generatedAt: now() },
            updatedAt: now()
        });
        return true;
    }
    private async recomputeSavedDocument(document: vscode.TextDocument): Promise<boolean> {
        const path = this.relativePath(document.uri);
        const store = this.storeFor(document.uri);
        if (path === undefined || store === undefined) {
            return false;
        }
        const existing = await store.load(path);
        if (existing === undefined) {
            return this.recompute(document.uri, true, true);
        }
        const { bytes } = await this.readStableSource(document.uri, this.maxSize());
        const baseline = await store.loadBaseline(existing, this.maxSize());
        const hunks = await this.git.diff(baseline, bytes);
        const addedLines = new Set<number>();
        for (const hunk of hunks) {
            for (let line = hunk.newStart; line < hunk.newStart + hunk.newCount; line += 1) {
                addedLines.add(line);
            }
        }
        const annotation = revExtEdits(Array.from({ length: document.lineCount }, (_, index) => document.lineAt(index).text), addedLines, document.languageId, existing.nextRevExtId);
        if (annotation.edits.length === 0) {
            return this.recompute(document.uri, true, true);
        }
        const edit = new vscode.WorkspaceEdit();
        for (const change of annotation.edits) {
            const line = document.lineAt(change.line - 1);
            edit.insert(document.uri, line.range.end, change.suffix);
        }
        if (!(await vscode.workspace.applyEdit(edit))) {
            throw new Error('Could not add RevExt identity comments.');
        }
        this.internalSaves.add(document.uri.toString());
        try {
            if (!(await document.save())) {
                throw new Error('Could not save RevExt identity comments.');
            }
        } finally {
            this.internalSaves.delete(document.uri.toString());
        }
        const changed = await this.recompute(document.uri, true, true);
        const updated = await store.load(path);
        if (updated !== undefined && updated.nextRevExtId !== annotation.nextId) {
            await store.commit(path, { ...updated, nextRevExtId: annotation.nextId, updatedAt: now() });
        }
        return changed;
    }
    private async createRecord(path: string, baseline: Uint8Array, current: Uint8Array, source: SourceSnapshot, lastReviewTime?: string): Promise<FileRecord> {
        const baselineDigest = digestBytes(baseline);
        const generatedAt = now();
        const diff = buildDiffRecords(baseline, current, await this.git.diff(baseline, current));
        return {
            baseline: { file: snapshotFileName(path, baselineDigest), digest: baselineDigest, codec: 'gzip', size: baseline.byteLength, createdAt: generatedAt },
            current: { digest: digestBytes(current), ...source, gitAlgorithm: 'myers', generatedAt },
            fileStatus: fileStatus(diff),
            nextRevExtId: 1,
            lastReviewTime,
            ...diff, updatedAt: generatedAt
        };
    }
    private async requireFresh(source: vscode.Uri, identity?: BaselineIdentity): Promise<FileRecord> {
        await this.recompute(source, true);
        const path = this.relativePath(source);
        const file = path === undefined ? undefined : await this.storeFor(source)?.load(path);
        if (file === undefined) {
            throw new Error('This file has not been initialized for review.');
        }
        if (identity !== undefined && (identity.baselineDigest !== file.baseline.digest || identity.currentDigest !== file.current.digest)) {
            throw new Error('This review diff is stale. Reopen Code Review: Open Review Diff.');
        }
        return file;
    }
    private async commitReview(source: vscode.Uri, file: FileRecord): Promise<void> {
        const path = this.relativePath(source);
        const store = this.storeFor(source);
        if (path === undefined || store === undefined) {
            return;
        }
        await store.commit(path, file);
        const changes = reviewableLines(file);
        if (file.baseline.digest !== file.current.digest && changes.length > 0 && changes.every(line => line.reviewStatus === 'reviewed')) {
            await this.promote(source, file);
            return;
        }
        this.changedEmitter.fire(source);
    }
    private async applyReview(source: vscode.Uri, file: FileRecord, status: ReviewStatus, reviewer: Reviewer | undefined, matchesCurrent: (line: FileRecord['currentLines'][number]) => boolean, matchesDeleted: (line: FileRecord['deletedLines'][number]) => boolean): Promise<boolean> {
        const at = now();
        const lastReviewer = setReviewer(status, reviewer, at);
        const currentLines = file.currentLines.map(line => matchesCurrent(line)
            ? { ...line, reviewStatus: status, lastReviewer }
            : line);
        const deletedLines = file.deletedLines.map(line => matchesDeleted(line)
            ? { ...line, reviewStatus: status, lastReviewer }
            : line);
        const changed = currentLines.some((line, index) => line !== file.currentLines[index])
            || deletedLines.some((line, index) => line !== file.deletedLines[index]);
        if (!changed) {
            return false;
        }
        await this.commitReview(source, { ...file, currentLines, deletedLines, lastReviewTime: at, updatedAt: at });
        return true;
    }
    private async promote(source: vscode.Uri, expected: FileRecord): Promise<void> {
        const path = this.relativePath(source);
        const store = this.storeFor(source);
        if (path === undefined || store === undefined) {
            return;
        }
        let { bytes, source: stat } = await this.readStableSource(source, this.maxSize());
        if (digestBytes(bytes) !== expected.current.digest) {
            await this.recompute(source, true);
            return;
        }
        const document = await vscode.workspace.openTextDocument(source);
        const removals = revExtRemovals(Array.from({ length: document.lineCount }, (_, index) => document.lineAt(index).text), new Set(expected.currentLines.filter(line => line.changeType === 'added').map(line => line.line)), document.languageId);
        if (removals.length > 0) {
            const edit = new vscode.WorkspaceEdit();
            for (const removal of removals) {
                const line = document.lineAt(removal.line - 1);
                edit.delete(source, new vscode.Range(line.lineNumber, removal.start, line.lineNumber, line.range.end.character));
            }
            if (!(await vscode.workspace.applyEdit(edit))) {
                throw new Error('Could not remove RevExt identity comments.');
            }
            this.internalSaves.add(source.toString());
            try {
                if (!(await document.save())) {
                    throw new Error('Could not save removed RevExt identity comments.');
                }
            } finally {
                this.internalSaves.delete(source.toString());
            }
            ({ bytes, source: stat } = await this.readStableSource(source, this.maxSize()));
        }
        const promoted = await this.createRecord(path, bytes, bytes, stat, expected.lastReviewTime);
        await store.commit(path, promoted, bytes);
        this.changedEmitter.fire(source);
        this.promotedEmitter.fire(source);
    }
    private storeFor(uri: vscode.Uri): PersistentStore | undefined {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        return folder === undefined ? undefined : this.stores.get(folder.uri.toString());
    }
    private isTrackableUri(uri: vscode.Uri): boolean {
        if (!this.isEligibleSourceUri(uri)) {
            return false;
        }
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (folder === undefined) {
            return false;
        }
        return this.eligiblePaths.get(folder.uri.toString())?.has(this.relativePath(uri) ?? '') ?? false;
    }
    private isEligibleSourceUri(uri: vscode.Uri): boolean {
        if (uri.scheme !== 'file') {
            return false;
        }
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (folder === undefined) {
            return false;
        }
        const store = this.stores.get(folder.uri.toString());
        const path = this.relativePath(uri);
        return store?.owns(uri) !== true && path !== undefined && !isExcludedPath(path);
    }
    private dirtyDocument(source: vscode.Uri): vscode.TextDocument | undefined {
        return vscode.workspace.textDocuments.find(document => document.uri.toString() === source.toString() && document.isDirty);
    }
    private maxSize(): number { return vscode.workspace.getConfiguration('codeReviewTracker').get<number>('maxFileSizeBytes', 1048576); }
    private async readStableSource(uri: vscode.Uri, maxSize: number): Promise<{
        bytes: Uint8Array;
        source: SourceSnapshot;
    }> {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const before = await vscode.workspace.fs.stat(uri);
            if (before.size > maxSize) {
                throw new Error('File exceeds the configured size limit');
            }
            const bytes = await vscode.workspace.fs.readFile(uri);
            const after = await vscode.workspace.fs.stat(uri);
            if (before.mtime !== after.mtime || before.size !== after.size || bytes.byteLength !== after.size) {
                continue;
            }
            if (bytes.includes(0)) {
                throw new Error('Binary files are unsupported');
            }
            physicalLines(bytes);
            return { bytes, source: { modifiedAt: after.mtime, size: after.size } };
        }
        throw new Error(`Source changed while it was being read: ${uri.toString()}`);
    }
    private async withSource<T>(uri: vscode.Uri, operation: () => Promise<T>): Promise<T> {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (folder !== undefined && this.initializingFolders.has(folder.uri.toString())) {
            throw new Error('Workspace review initialization is in progress.');
        }
        const key = uri.toString();
        const previous = this.sourceTails.get(key) ?? Promise.resolve();
        const current = previous.then(operation);
        const tail = current.then(() => undefined, () => undefined);
        this.sourceTails.set(key, tail);
        try {
            return await current;
        } finally {
            if (this.sourceTails.get(key) === tail) {
                this.sourceTails.delete(key);
            }
        }
    }
}
function selectedLines(selections: readonly vscode.Selection[]): ReadonlySet<number> {
    const result = new Set<number>();
    for (const selection of selections) {
        const start = selection.start.line;
        const end = selection.end.line - (!selection.isEmpty && selection.end.character === 0 ? 1 : 0);
        for (let line = start; line <= Math.max(start, end); line += 1) {
            result.add(line + 1);
        }
    }
    return result;
}
function inRange(line: number, start: number, count: number): boolean {
    return count > 0 && line >= start && line < start + count;
}
function isExcludedPath(path: string): boolean {
    return path === '.git' || path.startsWith('.git/')
        || path === 'node_modules' || path.startsWith('node_modules/')
        || path === '.vscode/code-review-tracker' || path.startsWith('.vscode/code-review-tracker/');
}
function isFileNotFound(error: unknown): boolean { return error instanceof vscode.FileSystemError && error.code === 'FileNotFound'; }
