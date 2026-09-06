import * as vscode from "vscode";
import type { ReviewStatus } from "../domain";
import type { ReviewService } from "../review-service";
import { statusText } from "./formatting";

type TreeNode =
  | {
      readonly kind: "group";
      readonly status: ReviewStatus;
    }
  | {
      readonly kind: "file";
      readonly uri: vscode.Uri;
      readonly label: string;
      readonly status: ReviewStatus;
      readonly reviewed: number;
      readonly total: number;
    };

export class ReviewTree
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;
  private cachedSummary: readonly { uri: vscode.Uri; path: string; status: ReviewStatus; reviewed: number; total: number }[] | undefined;
  private cachedGrouped: Map<ReviewStatus, readonly { uri: vscode.Uri; path: string; status: ReviewStatus; reviewed: number; total: number }[]> | undefined;
  constructor(private readonly service: ReviewService) {
    this.subscription = service.onDidChange(() => {
      this.cachedSummary = undefined;
      this.cachedGrouped = undefined;
      this.emitter.fire(undefined);
    });
  }

  private ensureGrouped(): Map<ReviewStatus, readonly { uri: vscode.Uri; path: string; status: ReviewStatus; reviewed: number; total: number }[]> {
    if (this.cachedGrouped !== undefined && this.cachedSummary !== undefined) {
      return this.cachedGrouped;
    }
    const summary = this.service.summary();
    this.cachedSummary = summary;
    const grouped = new Map<ReviewStatus, { uri: vscode.Uri; path: string; status: ReviewStatus; reviewed: number; total: number }[]>();
    for (const status of ["pending", "inReview", "reviewed"] as const) {
      grouped.set(status, []);
    }
    for (const file of summary) {
      grouped.get(file.status)?.push(file);
    }
    for (const status of ["pending", "inReview", "reviewed"] as const) {
      grouped.get(status)?.sort((a, b) => a.path.localeCompare(b.path));
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    this.cachedGrouped = grouped as unknown as Map<ReviewStatus, readonly { uri: vscode.Uri; path: string; status: ReviewStatus; reviewed: number; total: number }[]>;
    return this.cachedGrouped;
  }
  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "group") {
      const item = new vscode.TreeItem(
        statusText[node.status],
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon(
        node.status === "reviewed"
          ? "pass-filled"
          : node.status === "inReview"
            ? "circle-filled"
            : "circle-outline",
      );
      return item;
    }
    const item = new vscode.TreeItem(node.label);
    item.description = `${node.reviewed}/${node.total}`;
    item.tooltip = `${statusText[node.status]} — ${node.reviewed}/${node.total} changes reviewed`;
    item.resourceUri = node.uri;
    item.command = {
      command: "codeReviewTracker.openReviewDiff",
      title: "Open review diff",
      arguments: [node.uri],
    };
    return item;
  }
  getChildren(node?: TreeNode): vscode.ProviderResult<TreeNode[]> {
    if (node === undefined) {
      return (["pending", "inReview", "reviewed"] as const).map((status) => ({
        kind: "group",
        status,
      }));
    }
    if (node.kind === "file") {
      return [];
    }
    const grouped = this.ensureGrouped();
    return (grouped.get(node.status) ?? []).map((file) => ({
      kind: "file",
      uri: file.uri,
      label: file.path,
      status: file.status,
      reviewed: file.reviewed,
      total: file.total,
    }));
  }
  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
