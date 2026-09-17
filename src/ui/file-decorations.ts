import * as vscode from "vscode";
import type { ReviewService } from "../review-service";
import { statusIcon, statusText } from "./formatting";

const reviewedColor = new vscode.ThemeColor("testing.iconPassed");
const queuedColor = new vscode.ThemeColor("testing.iconQueued");

export class ReviewFileDecorations
  implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly subscription: vscode.Disposable;
  constructor(private readonly service: ReviewService) {
    this.subscription = service.onDidChange((uri) => this.emitter.fire(uri));
  }
  provideFileDecoration(
    uri: vscode.Uri,
  ): vscode.ProviderResult<vscode.FileDecoration> {
    const status = this.service.status(uri);
    if (status === undefined) {
      return undefined;
    }
    const color =
      status === "reviewed"
        ? reviewedColor
        : status === "inReview"
          ? queuedColor
          : undefined;
    const item = new vscode.FileDecoration(
      statusIcon[status],
      statusText[status],
      color,
    );
    item.propagate = true;
    return item;
  }
  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
