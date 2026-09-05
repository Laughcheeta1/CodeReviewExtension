import * as vscode from "vscode";
import type { ReviewService } from "../review-service";
import { statusIcon, statusText } from "./formatting";

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
        ? new vscode.ThemeColor("testing.iconPassed")
        : status === "inReview"
          ? new vscode.ThemeColor("testing.iconQueued")
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
