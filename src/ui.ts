import * as vscode from "vscode";
import type { ReviewStatus } from "./domain";
import { revExtMarkerStart } from "./revext";
import type { ReviewService } from "./review-service";
const statusText: Record<ReviewStatus, string> = {
  pending: "Pending review",
  inReview: "In review",
  reviewed: "Reviewed",
};  // RevExt: 1
const statusIcon: Record<ReviewStatus, string> = {
  pending: "P",
  inReview: "●",
  reviewed: "✓",
};  // RevExt: 2
export class BaselineContentProvider
  implements vscode.TextDocumentContentProvider {
  constructor(private readonly service: ReviewService) {}
  provideTextDocumentContent(uri: vscode.Uri): vscode.ProviderResult<string> {
    return this.service.baselineContent(uri);
  }  // RevExt: 14
}  // RevExt: 4
export class ReviewDecorations implements vscode.Disposable {
  private readonly types: Record<ReviewStatus, vscode.TextEditorDecorationType>;
  private readonly revExtType = vscode.window.createTextEditorDecorationType({
    color: "transparent",
  });
  private readonly changeSubscription: vscode.Disposable;
  private readonly documentSubscription: vscode.Disposable;
  constructor(private readonly service: ReviewService) {  // RevExt: 33
    this.types = {
      pending: vscode.window.createTextEditorDecorationType({
        gutterIconPath: svg("8c959f"),
        gutterIconSize: "contain",  // RevExt: 37
      }),  // RevExt: 40
      inReview: vscode.window.createTextEditorDecorationType({
        gutterIconPath: svg("d29922"),
        gutterIconSize: "contain",  // RevExt: 38
      }),  // RevExt: 41
      reviewed: vscode.window.createTextEditorDecorationType({
        gutterIconPath: svg("3fb950"),
        gutterIconSize: "contain",  // RevExt: 39
      }),  // RevExt: 42
    };  // RevExt: 43
    this.changeSubscription = service.onDidChange(() => this.refresh());
    this.documentSubscription = vscode.workspace.onDidChangeTextDocument(() =>
      this.refresh(),
    );  // RevExt: 46
  }  // RevExt: 15
  refresh(): void {
    void this.refreshVisible();
  }  // RevExt: 16
  private refreshVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      for (const type of Object.values(this.types)) {
        editor.setDecorations(type, []);
      }  // RevExt: 49
      editor.setDecorations(this.revExtType, revExtDecorations(editor.document));
      const identity = this.service.parseBaselineUri(editor.document.uri);
      const source = identity?.source ?? editor.document.uri;
      if (identity === undefined && this.service.isTrackable(editor.document)) {
        void this.service.ensureDocument(editor.document);
      }  // RevExt: 50
      const file = this.service.file(source);
      if (file === undefined) {
        continue;
      }  // RevExt: 51
      const options: Record<ReviewStatus, vscode.DecorationOptions[]> = {
        pending: [],
        inReview: [],
        reviewed: [],
      };  // RevExt: 57
      if (identity === undefined) {
        for (const line of file.currentLines.filter(
          (line) => line.changeType !== "unchanged",
        )) {
          if (line.line > editor.document.lineCount) {
            continue;
          }
          options[line.reviewStatus].push(  // RevExt: 60
            decoration(  // RevExt: 62
              line.line,
              line.changeType,
              line.reviewStatus,  // RevExt: 64
              line.lastReviewer,  // RevExt: 66
            ),  // RevExt: 68
          );  // RevExt: 71
        }  // RevExt: 73
      } else if (
        identity.baselineDigest === file.baseline.digest &&
        identity.currentDigest === file.current.digest
      ) {
        for (const line of file.deletedLines) {
          options[line.reviewStatus].push(  // RevExt: 61
            decoration(  // RevExt: 63
              line.baselineLine,
              "deleted",
              line.reviewStatus,  // RevExt: 65
              line.lastReviewer,  // RevExt: 67
            ),  // RevExt: 69
          );  // RevExt: 72
        }  // RevExt: 74
      }  // RevExt: 52
      for (const status of ["pending", "inReview", "reviewed"] as const) {
        editor.setDecorations(this.types[status], options[status]);
      }  // RevExt: 53
    }  // RevExt: 75
  }  // RevExt: 17
  dispose(): void {  // RevExt: 85
    this.changeSubscription.dispose();
    this.documentSubscription.dispose();
    for (const type of Object.values(this.types)) {
      type.dispose();
    }  // RevExt: 76
    this.revExtType.dispose();
  }  // RevExt: 18
}  // RevExt: 5
// RevExt: 90
function revExtDecorations(
  document: vscode.TextDocument,
): readonly vscode.DecorationOptions[] {
  const result: vscode.DecorationOptions[] = [];
  for (let line = 0; line < document.lineCount; line += 1) {
    const start = revExtMarkerStart(document.lineAt(line).text, document.languageId);
    if (start === undefined) {
      continue;
    }  // RevExt: 77
    result.push({
      range: new vscode.Range(line, start, line, document.lineAt(line).text.length),
    });  // RevExt: 93
  }  // RevExt: 19
  return result;
}  // RevExt: 6
export class ReviewFileDecorations
  implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly subscription: vscode.Disposable;  // RevExt: 99
  constructor(private readonly service: ReviewService) {  // RevExt: 35
    this.subscription = service.onDidChange((uri) => this.emitter.fire(uri));
  }  // RevExt: 25
  provideFileDecoration(
    uri: vscode.Uri,
  ): vscode.ProviderResult<vscode.FileDecoration> {
    const status = this.service.status(uri);
    if (status === undefined) {
      return undefined;
    }  // RevExt: 80
    const color =
      status === "reviewed"
        ? new vscode.ThemeColor("testing.iconPassed")
        : status === "inReview"
          ? new vscode.ThemeColor("testing.iconQueued")
          : undefined;
    const item = new vscode.FileDecoration(
      statusIcon[status],
      statusText[status],
      color,
    );  // RevExt: 48
    item.propagate = true;
    return item;  // RevExt: 127
  }  // RevExt: 26
  dispose(): void {  // RevExt: 88
    this.subscription.dispose();  // RevExt: 119
    this.emitter.dispose();  // RevExt: 123
  }  // RevExt: 27
}  // RevExt: 10
type TreeNode =
  | {  // RevExt: 129
      readonly kind: "group";
      readonly status: ReviewStatus;  // RevExt: 131
    }  // RevExt: 81
  | {  // RevExt: 130
      readonly kind: "file";
      readonly uri: vscode.Uri;
      readonly label: string;
      readonly status: ReviewStatus;  // RevExt: 132
      readonly reviewed: number;
      readonly total: number;
    };  // RevExt: 44
export class ReviewTree
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;  // RevExt: 100
  constructor(private readonly service: ReviewService) {  // RevExt: 36
    this.subscription = service.onDidChange(() => this.emitter.fire(undefined));
  }  // RevExt: 28
  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "group") {
      const item = new vscode.TreeItem(
        statusText[node.status],
        vscode.TreeItemCollapsibleState.Expanded,
      );  // RevExt: 116
      item.iconPath = new vscode.ThemeIcon(
        node.status === "reviewed"
          ? "pass-filled"
          : node.status === "inReview"
            ? "circle-filled"
            : "circle-outline",
      );  // RevExt: 117
      return item;
    }  // RevExt: 82
    const item = new vscode.TreeItem(node.label);
    item.description = `${node.reviewed}/${node.total}`;
    item.tooltip = `${statusText[node.status]} — ${node.reviewed}/${node.total} changes reviewed`;
    item.resourceUri = node.uri;
    item.command = {
      command: "codeReviewTracker.openReviewDiff",
      title: "Open review diff",
      arguments: [node.uri],
    };  // RevExt: 45
    return item;  // RevExt: 128
  }  // RevExt: 29
  getChildren(node?: TreeNode): vscode.ProviderResult<TreeNode[]> {
    if (node === undefined) {
      return (["pending", "inReview", "reviewed"] as const).map((status) => ({
        kind: "group",
        status,
      }));  // RevExt: 133
    }  // RevExt: 83
    if (node.kind === "file") {
      return [];  // RevExt: 107
    }  // RevExt: 84
    return this.service
      .summary()
      .filter((file) => file.status === node.status)
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => ({
        kind: "file",
        uri: file.uri,
        label: file.path,
        status: file.status,
        reviewed: file.reviewed,
        total: file.total,
      }));  // RevExt: 134
  }  // RevExt: 30
  dispose(): void {  // RevExt: 89
    this.subscription.dispose();  // RevExt: 120
    this.emitter.dispose();  // RevExt: 124
  }  // RevExt: 31
}  // RevExt: 11
function decoration(
  line: number,
  change: string,
  status: ReviewStatus,
  lastReviewer:
    | {
        name: string;
        time: string;
      }  // RevExt: 56
    | undefined,
): vscode.DecorationOptions {
  const hoverMessage = new vscode.MarkdownString();
  hoverMessage.appendText(`${change}: ${statusText[status]}`);
  if (lastReviewer !== undefined) {
    hoverMessage.appendText(` by ${lastReviewer.name} on ${lastReviewer.time}`);
  }  // RevExt: 32
  return { range: new vscode.Range(line - 1, 0, line - 1, 0), hoverMessage };
}  // RevExt: 12
function svg(color: string): vscode.Uri {
  return vscode.Uri.parse(
    `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5" fill="#${color}"/></svg>`)}`,
  );  // RevExt: 126
}  // RevExt: 13
// RevExt: 92
