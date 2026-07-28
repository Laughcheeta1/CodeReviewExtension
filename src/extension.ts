import * as vscode from 'vscode';
import { terminalPayload, type ReviewStatus, type Reviewer } from './domain';
import { GitService } from './git';
import { ReviewService } from './review-service';
import { BaselineContentProvider, ReviewCodeLensProvider, ReviewDecorations, ReviewFileDecorations, ReviewInlayHints, ReviewTree, type HunkCommand } from './ui';
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const log = vscode.window.createOutputChannel('Code Review Tracker', { log: true });
    context.subscriptions.push(log);
    if (vscode.workspace.workspaceFolders === undefined) {
        log.info('No workspace folder is open.');
        return;
    }
    const git = new GitService();
    if (!(await git.available())) {
        void vscode.window.showErrorMessage('Code Review Tracker requires the Git executable for baseline diffs.');
        return;
    }
    const service = new ReviewService(log, git);
    await service.initialize();
    context.subscriptions.push(service);
    for (const folder of vscode.workspace.workspaceFolders) {
        service.setEligiblePaths(folder, await eligibleWorkspacePaths(folder));
        await service.reconcileExternalChanges(folder);
    }
    const decorations = new ReviewDecorations(service);
    const codeLens = new ReviewCodeLensProvider(service);
    const tree = new ReviewTree(service);
    const fileDecorations = new ReviewFileDecorations(service);
    const inlayHints = new ReviewInlayHints();
    context.subscriptions.push(decorations, codeLens, tree, fileDecorations, inlayHints);
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('code-review-baseline', new BaselineContentProvider(service)), vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'code-review-baseline' }], codeLens), vscode.window.registerTreeDataProvider('codeReviewTracker.files', tree), vscode.window.registerFileDecorationProvider(fileDecorations), vscode.languages.registerInlayHintsProvider({ scheme: 'file' }, inlayHints), vscode.workspace.onDidOpenTextDocument(document => runLogged(log, 'Document loading', service.ensureDocument(document))), vscode.workspace.onDidSaveTextDocument(document => runLogged(log, 'Saved-file reconciliation', service.reconcileSavedDocument(document))), service.onDidPromote(source => runLogged(log, 'Closing promoted diff tabs', closePromotedDiffTabs(source))), vscode.window.onDidChangeVisibleTextEditors(() => decorations.refresh()), vscode.commands.registerCommand('codeReviewTracker.markPending', () => markActive(service, git, 'pending')), vscode.commands.registerCommand('codeReviewTracker.markInReview', () => markActive(service, git, 'inReview')), vscode.commands.registerCommand('codeReviewTracker.markReviewed', () => markActive(service, git, 'reviewed')), vscode.commands.registerCommand('codeReviewTracker.markHunkPending', (command: HunkCommand) => markHunk(service, git, command)), vscode.commands.registerCommand('codeReviewTracker.markHunkReviewed', (command: HunkCommand) => markHunk(service, git, command)), vscode.commands.registerCommand('codeReviewTracker.openReviewDiff', (uri?: vscode.Uri) => openReviewDiff(service, uri)), vscode.commands.registerCommand('codeReviewTracker.initializeReviewed', () => initializeAll(service, 'reviewed')), vscode.commands.registerCommand('codeReviewTracker.initializePending', () => initializeAll(service, 'pending')), vscode.commands.registerCommand('codeReviewTracker.sendSelectionToTerminal', () => sendSelection(service)), vscode.commands.registerCommand('codeReviewTracker.refresh', async () => {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            service.setEligiblePaths(folder, await eligibleWorkspacePaths(folder));
            await service.reconcileExternalChanges(folder, true);
        }
    }), vscode.commands.registerCommand('codeReviewTracker.showLogs', () => log.show()));
    for (const folder of vscode.workspace.workspaceFolders) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'), true, true, false);
        context.subscriptions.push(watcher, watcher.onDidDelete(uri => runLogged(log, 'Source deletion', service.removeSources([uri]))));
    }
    for (const editor of vscode.window.visibleTextEditors) {
        await service.ensureDocument(editor.document);
    }
    runLogged(log, 'Initialization prompt', promptForInitialization(service));
    decorations.refresh();
    log.info('Code Review Tracker 0.4.0 activated.');
}
async function promptForInitialization(service: ReviewService): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (service.hasMetadata(folder)) {
            continue;
        }
        const choice = await vscode.window.showInformationMessage(`Initialize code review baselines for ${folder.name}?`, 'Start Reviewed', 'Start Pending');
        if (choice === 'Start Reviewed') {
            await service.initializeFolder(folder, 'reviewed');
        }
        if (choice === 'Start Pending') {
            await service.initializeFolder(folder, 'pending');
        }
    }
}
async function openReviewDiff(service: ReviewService, uri?: vscode.Uri): Promise<void> {
    const requested = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (requested === undefined) {
        return;
    }
    const source = service.parseBaselineUri(requested)?.source ?? requested;
    try {
        const prepared = await service.prepareDiff(source);
        if (prepared === undefined) {
            void vscode.window.showInformationMessage('Initialize this workspace before opening review diffs.');
            return;
        }
        if (prepared.file.hunks.length === 0) {
            await vscode.window.showTextDocument(source);
            return;
        }
        const path = service.relativePath(source) ?? source.path;
        await vscode.commands.executeCommand('vscode.diff', prepared.baseline, source, `Code Review: ${path}`);
    } catch (error) {
        void vscode.window.showWarningMessage(errorMessage(error));
    }
}
async function closePromotedDiffTabs(source: vscode.Uri): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
        const stale = group.tabs.filter(tab => tab.input instanceof vscode.TabInputTextDiff
            && tab.input.original.scheme === 'code-review-baseline'
            && tab.input.modified.toString() === source.toString());
        if (stale.length > 0) {
            await vscode.window.tabGroups.close(stale, true);
        }
    }
}
async function reviewer(git: GitService, uri?: vscode.Uri): Promise<Reviewer | undefined> {
    const fromGit = await git.reviewer(uri === undefined ? undefined : vscode.workspace.getWorkspaceFolder(uri));
    if (fromGit !== undefined) {
        return fromGit;
    }
    const config = vscode.workspace.getConfiguration('codeReviewTracker');
    const configuredName = config.get<string>('reviewerName', '').trim();
    const configuredEmail = config.get<string>('reviewerEmail', '').trim();
    let name = configuredName;
    let email = configuredEmail;
    if (name.length === 0) {
        name = (await vscode.window.showInputBox({ prompt: 'Reviewer name', ignoreFocusOut: true }))?.trim() ?? '';
    }
    if (name.length === 0) {
        return undefined;
    }
    if (email.length === 0) {
        email = (await vscode.window.showInputBox({ prompt: 'Reviewer email (optional)', ignoreFocusOut: true }))?.trim() ?? '';
    }
    if (configuredName.length === 0) {
        await config.update('reviewerName', name, vscode.ConfigurationTarget.Global);
    }
    if (email.length > 0 && configuredEmail.length === 0) {
        await config.update('reviewerEmail', email, vscode.ConfigurationTarget.Global);
    }
    return email.length > 0 ? { name, email } : { name };
}
async function markActive(service: ReviewService, git: GitService, status: ReviewStatus): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
        return;
    }
    const source = service.parseBaselineUri(editor.document.uri)?.source ?? editor.document.uri;
    const identity = status === 'pending' ? undefined : await reviewer(git, source);
    if (status !== 'pending' && identity === undefined) {
        return;
    }
    try {
        if (!(await service.markEditor(editor, status, identity))) {
            void vscode.window.showInformationMessage('The selection contains no reviewable changes.');
        }
    } catch (error) {
        void vscode.window.showWarningMessage(errorMessage(error));
    }
}
async function markHunk(service: ReviewService, git: GitService, command: HunkCommand | undefined): Promise<void> {
    if (command === undefined) {
        return;
    }
    const identity = command.status === 'pending' ? undefined : await reviewer(git, command.source);
    if (command.status !== 'pending' && identity === undefined) {
        return;
    }
    try {
        await service.markHunk(command.source, command.baselineDigest, command.currentDigest, command.hunkIndex, command.status, identity);
    } catch (error) {
        void vscode.window.showWarningMessage(errorMessage(error));
    }
}
async function initializeAll(service: ReviewService, status: 'pending' | 'reviewed'): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        try {
            await service.initializeFolder(folder, status);
        } catch (error) {
            void vscode.window.showErrorMessage(errorMessage(error));
        }
    }
}
function selectionRanges(editor: vscode.TextEditor): readonly {
    start: number;
    end: number;
}[] {
    const unique = new Map<string, {
        start: number;
        end: number;
    }>();
    for (const selection of editor.selections) {
        const start = selection.isEmpty ? selection.active.line : selection.start.line;
        const end = selection.isEmpty ? start : selection.end.line;
        unique.set(`${start}:${end}`, { start, end });
    }
    return [...unique.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}
function sendSelection(service: ReviewService): void {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || editor.document.uri.scheme !== 'file') {
        return;
    }
    const path = service.relativePath(editor.document.uri);
    if (path === undefined) {
        return;
    }
    const payload = terminalPayload(path, editor.document.getText(), selectionRanges(editor));
    let terminal = vscode.window.activeTerminal;
    if (terminal === undefined) {
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        terminal = folder === undefined ? vscode.window.createTerminal({ name: 'Code Review Agent' }) : vscode.window.createTerminal({ name: 'Code Review Agent', cwd: folder.uri });
        terminal.show(true);
        const command = vscode.workspace.getConfiguration('codeReviewTracker').get<string>('agentCommand', '').trim();
        if (command.length > 0 && vscode.workspace.isTrusted) {
            terminal.sendText(command, true);
        }
    }
    terminal.sendText(payload, false);
}
async function eligibleWorkspacePaths(folder: vscode.WorkspaceFolder): Promise<readonly string[]> {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), new vscode.RelativePattern(folder, '**/{.git,node_modules,.vscode/code-review-tracker}/**'));
    return uris.map(uri => vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/'));
}
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
function runLogged(log: vscode.LogOutputChannel, action: string, operation: Promise<unknown>): void {
    void operation.catch(error => log.warn(`${action} failed: ${errorMessage(error)}`));
}

