import * as vscode from 'vscode';
import type { ReviewStatus } from './domain';
import type { ReviewService } from './review-service';
const statusText: Record<ReviewStatus, string> = {
    pending: 'Pending review',
    inReview: 'In review',
    reviewed: 'Reviewed'
};
const statusIcon: Record<ReviewStatus, string> = { pending: 'P', inReview: '●', reviewed: '✓' };
export interface HunkCommand {
    readonly source: vscode.Uri;
    readonly baselineDigest: string;
    readonly currentDigest: string;
    readonly hunkIndex: number;
    readonly status: 'pending' | 'reviewed';
}
export class BaselineContentProvider implements vscode.TextDocumentContentProvider {
    constructor(private readonly service: ReviewService) { }
    provideTextDocumentContent(uri: vscode.Uri): vscode.ProviderResult<string> {
        return this.service.baselineContent(uri);
    }
}
export class ReviewDecorations implements vscode.Disposable {
    private readonly types: Record<ReviewStatus, vscode.TextEditorDecorationType>;
    private readonly changeSubscription: vscode.Disposable;
    constructor(private readonly service: ReviewService) {
        this.types = {
            pending: vscode.window.createTextEditorDecorationType({
                gutterIconPath: svg('8c959f'),
                gutterIconSize: 'contain'
            }),
            inReview: vscode.window.createTextEditorDecorationType({
                gutterIconPath: svg('d29922'),
                gutterIconSize: 'contain'
            }),
            reviewed: vscode.window.createTextEditorDecorationType({
                gutterIconPath: svg('3fb950'),
                gutterIconSize: 'contain'
            })
        };
        this.changeSubscription = service.onDidChange(() => this.refresh());
    }
    refresh(): void { void this.refreshVisible(); }
    private refreshVisible(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            for (const type of Object.values(this.types)) {
                editor.setDecorations(type, []);
            }
            const identity = this.service.parseBaselineUri(editor.document.uri);
            const source = identity?.source ?? editor.document.uri;
            if (identity === undefined && this.service.isTrackable(editor.document)) {
                void this.service.ensureDocument(editor.document);
            }
            const file = this.service.file(source);
            if (file === undefined) {
                continue;
            }
            const options: Record<ReviewStatus, vscode.DecorationOptions[]> = {
                pending: [],
                inReview: [],
                reviewed: []
            };
            if (identity === undefined) {
                for (const line of file.currentLines.filter(line => line.changeType !== 'unchanged')) {
                    if (line.line > editor.document.lineCount) {
                        continue;
                    }
                    options[line.reviewStatus].push(
                        decoration(line.line, line.changeType, line.reviewStatus, line.lastReviewer)
                    );
                }
            } else if (identity.baselineDigest === file.baseline.digest && identity.currentDigest === file.current.digest) {
                for (const line of file.deletedLines) {
                    options[line.reviewStatus].push(decoration(line.baselineLine, 'deleted', line.reviewStatus, line.lastReviewer));
                }
            }
            for (const status of ['pending', 'inReview', 'reviewed'] as const) {
                editor.setDecorations(this.types[status], options[status]);
            }
        }
    }
    dispose(): void {
        this.changeSubscription.dispose();
        for (const type of Object.values(this.types)) {
            type.dispose();
        }
    }
}
export class ReviewCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.emitter.event;
    private readonly subscription: vscode.Disposable;
    constructor(private readonly service: ReviewService) {
        this.subscription = service.onDidChange(() => this.emitter.fire());
    }
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const identity = this.service.parseBaselineUri(document.uri);
        const source = identity?.source ?? document.uri;
        const file = this.service.file(source);
        if (file === undefined || (identity !== undefined && (
            identity.baselineDigest !== file.baseline.digest
            || identity.currentDigest !== file.current.digest
        ))) {
            return [];
        }
        const result: vscode.CodeLens[] = [];
        file.hunks.forEach((hunk, hunkIndex) => {
            const line = identity === undefined ? hunk.newStart : hunk.oldStart;
            const count = identity === undefined ? hunk.newCount : hunk.oldCount;
            if (count === 0 || line < 1 || line > document.lineCount) {
                return;
            }
            const range = new vscode.Range(line - 1, 0, line - 1, 0);
            const base = { source, baselineDigest: file.baseline.digest, currentDigest: file.current.digest, hunkIndex };
            result.push(new vscode.CodeLens(range, { command: 'codeReviewTracker.markHunkReviewed', title: '$(pass-filled) Mark hunk reviewed', arguments: [{ ...base, status: 'reviewed' }] }), new vscode.CodeLens(range, { command: 'codeReviewTracker.markHunkPending', title: '$(circle-outline) Mark hunk pending', arguments: [{ ...base, status: 'pending' }] }));
        });
        return result;
    }
    dispose(): void { this.subscription.dispose(); this.emitter.dispose(); }
}
export class ReviewInlayHints implements vscode.InlayHintsProvider<vscode.InlayHint>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeInlayHints = this.emitter.event;
    private readonly subscriptions = vscode.Disposable.from(vscode.window.onDidChangeTextEditorSelection(() => this.emitter.fire()), vscode.window.onDidChangeActiveTextEditor(() => this.emitter.fire()));
    provideInlayHints(document: vscode.TextDocument): vscode.ProviderResult<vscode.InlayHint[]> {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined || editor.document.uri.toString() !== document.uri.toString() || document.uri.scheme !== 'file') {
            return [];
        }
        const targets = new Set(editor.selections.map(selection => selection.isEmpty ? selection.active.line : Math.max(selection.start.line, selection.end.line - (selection.end.character === 0 ? 1 : 0))));
        return [...targets].map(line => {
            const part = new vscode.InlayHintLabelPart(' $(terminal) Send to Agent');
            part.command = { command: 'codeReviewTracker.sendSelectionToTerminal', title: 'Send selection to coding agent' };
            return new vscode.InlayHint(new vscode.Position(line, document.lineAt(line).text.length), [part]);
        });
    }
    dispose(): void { this.subscriptions.dispose(); this.emitter.dispose(); }
}
export class ReviewFileDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this.emitter.event;
    private readonly subscription: vscode.Disposable;
    constructor(private readonly service: ReviewService) {
        this.subscription = service.onDidChange(uri => this.emitter.fire(uri));
    }
    provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
        const status = this.service.status(uri);
        if (status === undefined) {
            return undefined;
        }
        const color = status === 'reviewed' ? new vscode.ThemeColor('testing.iconPassed') : status === 'inReview' ? new vscode.ThemeColor('testing.iconQueued') : undefined;
        const item = new vscode.FileDecoration(statusIcon[status], statusText[status], color);
        item.propagate = true;
        return item;
    }
    dispose(): void { this.subscription.dispose(); this.emitter.dispose(); }
}
type TreeNode = {
    readonly kind: 'group';
    readonly status: ReviewStatus;
} | {
    readonly kind: 'file';
    readonly uri: vscode.Uri;
    readonly label: string;
    readonly status: ReviewStatus;
    readonly reviewed: number;
    readonly total: number;
};
export class ReviewTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;
    private readonly subscription: vscode.Disposable;
    constructor(private readonly service: ReviewService) {
        this.subscription = service.onDidChange(() => this.emitter.fire(undefined));
    }
    getTreeItem(node: TreeNode): vscode.TreeItem {
        if (node.kind === 'group') {
            const item = new vscode.TreeItem(statusText[node.status], vscode.TreeItemCollapsibleState.Expanded);
            item.iconPath = new vscode.ThemeIcon(node.status === 'reviewed' ? 'pass-filled' : node.status === 'inReview' ? 'circle-filled' : 'circle-outline');
            return item;
        }
        const item = new vscode.TreeItem(node.label);
        item.description = `${node.reviewed}/${node.total}`;
        item.tooltip = `${statusText[node.status]} — ${node.reviewed}/${node.total} changes reviewed`;
        item.resourceUri = node.uri;
        item.command = { command: 'codeReviewTracker.openReviewDiff', title: 'Open review diff', arguments: [node.uri] };
        return item;
    }
    getChildren(node?: TreeNode): vscode.ProviderResult<TreeNode[]> {
        if (node === undefined) {
            return (['pending', 'inReview', 'reviewed'] as const).map(status => ({ kind: 'group', status }));
        }
        if (node.kind === 'file') {
            return [];
        }
        return this.service.summary().filter(file => file.status === node.status).sort((a, b) => a.path.localeCompare(b.path))
            .map(file => ({ kind: 'file', uri: file.uri, label: file.path, status: file.status, reviewed: file.reviewed, total: file.total }));
    }
    dispose(): void { this.subscription.dispose(); this.emitter.dispose(); }
}
function decoration(line: number, change: string, status: ReviewStatus, lastReviewer: {
    name: string;
    time: string;
} | undefined): vscode.DecorationOptions {
    const hoverMessage = new vscode.MarkdownString();
    hoverMessage.appendText(`${change}: ${statusText[status]}`);
    if (lastReviewer !== undefined) {
        hoverMessage.appendText(` by ${lastReviewer.name} on ${lastReviewer.time}`);
    }
    return { range: new vscode.Range(line - 1, 0, line - 1, 0), hoverMessage };
}
function svg(color: string): vscode.Uri {
    return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5" fill="#${color}"/></svg>`)}`);
}
