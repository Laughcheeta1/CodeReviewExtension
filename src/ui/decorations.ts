import * as vscode from "vscode";
import type { ReviewStatus } from "../domain";
import { revExtMarkerStart } from "../revext";
import { supportsRevExt } from "../revext-syntax";
import type { ReviewService } from "../review-service";
import { gutterIcon, lineDecoration } from "./formatting";

type DecorationService = Pick<ReviewService,
  "onDidChange" | "parseBaselineUri" | "isTrackable" | "ensureDocument" | "file"
>;

interface MarkerDecorations {
  readonly version: number;
  readonly languageId: string;
  readonly decorations: readonly vscode.DecorationOptions[];
}

export class ReviewDecorations implements vscode.Disposable {
  private readonly types: Record<ReviewStatus, vscode.TextEditorDecorationType>;
  private readonly revExtType = vscode.window.createTextEditorDecorationType({
    color: "transparent",
  });
  private readonly changeSubscription: vscode.Disposable;
  private readonly documentSubscription: vscode.Disposable;
  private refreshScheduled = false;
  private disposed = false;
  private refreshEverything = false;
  private readonly pendingDocuments = new Set<string>();
  private readonly revExtCache = new WeakMap<vscode.TextDocument, MarkerDecorations>();
  constructor(private readonly service: DecorationService) {
    this.types = {
      pending: vscode.window.createTextEditorDecorationType({
        gutterIconPath: gutterIcon("8c959f"),
        gutterIconSize: "contain",
      }),
      inReview: vscode.window.createTextEditorDecorationType({
        gutterIconPath: gutterIcon("d29922"),
        gutterIconSize: "contain",
      }),
      reviewed: vscode.window.createTextEditorDecorationType({
        gutterIconPath: gutterIcon("3fb950"),
        gutterIconSize: "contain",
      }),
    };
    this.changeSubscription = service.onDidChange(() => this.refresh());
    this.documentSubscription = vscode.workspace.onDidChangeTextDocument(
      ({ document }) => this.refreshDocument(document),
    );
  }
  refresh(): void {
    this.refreshEverything = true;
    this.scheduleRefresh();
  }
  private refreshDocument(document: vscode.TextDocument): void {
    this.pendingDocuments.add(document.uri.toString());
    this.scheduleRefresh();
  }
  private scheduleRefresh(): void {
    if (this.disposed || this.refreshScheduled) {
      return;
    }
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;
      if (this.disposed) {
        return;
      }
      const refreshEverything = this.refreshEverything;
      this.refreshEverything = false;
      const documents = new Set(this.pendingDocuments);
      this.pendingDocuments.clear();
      this.refreshVisible(refreshEverything ? undefined : documents);
    });
  }
  private refreshVisible(documentKeys?: ReadonlySet<string>): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (
        documentKeys !== undefined &&
        !documentKeys.has(editor.document.uri.toString())
      ) {
        continue;
      }
      editor.setDecorations(
        this.revExtType,
        this.cachedRevExtDecorations(editor.document),
      );
      const identity = this.service.parseBaselineUri(editor.document.uri);
      const source = identity?.source ?? editor.document.uri;
      if (identity === undefined && this.service.isTrackable(editor.document)) {
        void this.service.ensureDocument(editor.document);
      }
      const file = this.service.file(source);
      const options: Record<ReviewStatus, vscode.DecorationOptions[]> = {
        pending: [],
        inReview: [],
        reviewed: [],
      };
      if (file !== undefined && identity === undefined) {
        for (const line of file.currentLines) {
          if (line.changeType === "unchanged") {
            continue;
          }
          if (line.line > editor.document.lineCount) {
            continue;
          }
          options[line.reviewStatus].push(
            lineDecoration(
              line.line,
              line.changeType,
              line.reviewStatus,
              line.lastReviewer,
            ),
          );
        }
      } else if (
        file !== undefined &&
        identity !== undefined &&
        identity.baselineDigest === file.baseline.digest
      ) {
        // The current digest in an already-open diff can lag after a saved
        // edit. The latest file record is authoritative while the baseline
        // digest keeps this decoration bound to the correct left pane.
        for (const line of file.deletedLines) {
          options[line.reviewStatus].push(
            lineDecoration(
              line.baselineLine,
              "deleted",
              line.reviewStatus,
              line.lastReviewer,
            ),
          );
        }
      }
      for (const status of ["pending", "inReview", "reviewed"] as const) {
        editor.setDecorations(this.types[status], options[status]);
      }
    }
  }
  private cachedRevExtDecorations(
    document: vscode.TextDocument,
  ): readonly vscode.DecorationOptions[] {
    if (!supportsRevExt(document.languageId)) {
      return [];
    }
    const cached = this.revExtCache.get(document);
    if (
      cached !== undefined &&
      cached.version === document.version &&
      cached.languageId === document.languageId
    ) {
      return cached.decorations;
    }
    const result: vscode.DecorationOptions[] = [];
    for (let line = 0; line < document.lineCount; line += 1) {
      const text = document.lineAt(line).text;
      const start = revExtMarkerStart(text, document.languageId);
      if (start === undefined) {
        continue;
      }
      result.push({
        range: new vscode.Range(line, start, line, text.length),
      });
    }
    this.revExtCache.set(document, {
      version: document.version,
      languageId: document.languageId,
      decorations: result,
    });
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.pendingDocuments.clear();
    this.changeSubscription.dispose();
    this.documentSubscription.dispose();
    for (const type of Object.values(this.types)) {
      type.dispose();
    }
    this.revExtType.dispose();
  }
}
