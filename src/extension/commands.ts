import * as vscode from "vscode";
import type { GitIgnoreService } from "../git-ignore";
import { openReviewDiff } from "../review-commands/diff-view";
import {
  ignoreExtensionForRevExt,
  ignoreFileForRevExt,
  ignoreFolderForRevExt,
} from "../review-commands/revext-ignore";
import {
  markActive,
  markFile,
  markFolder,
} from "../review-commands/mark";
import {
  initializeAll,
  sendSelection,
} from "../review-commands/workspace";
import type { ReviewService } from "../review-service";
import type { ReviewerResolver } from "../reviewer";
import { promptForInitialization } from "../initialization-setup";
import { refreshFolder } from "./startup";

/** Register every `codeReviewTracker.*` command. */
export function registerCommands(
  context: vscode.ExtensionContext,
  service: ReviewService,
  reviewerResolver: ReviewerResolver,
  ignoreRules: GitIgnoreService,
  log: vscode.LogOutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("codeReviewTracker.markPending", () =>
      markActive(service, reviewerResolver, "pending"),
    ),
    vscode.commands.registerCommand("codeReviewTracker.markInReview", () =>
      markActive(service, reviewerResolver, "inReview"),
    ),
    vscode.commands.registerCommand("codeReviewTracker.markReviewed", () =>
      markActive(service, reviewerResolver, "reviewed"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.markFilePending",
      (uri?: vscode.Uri) =>
        markFile(service, reviewerResolver, uri, "pending"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.markFileInReview",
      (uri?: vscode.Uri) =>
        markFile(service, reviewerResolver, uri, "inReview"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.markFileReviewed",
      (uri?: vscode.Uri) =>
        markFile(service, reviewerResolver, uri, "reviewed"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.markFolderPending",
      (uri?: vscode.Uri) =>
        markFolder(service, reviewerResolver, uri, "pending"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.markFolderInReview",
      (uri?: vscode.Uri) =>
        markFolder(service, reviewerResolver, uri, "inReview"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.markFolderReviewed",
      (uri?: vscode.Uri) =>
        markFolder(service, reviewerResolver, uri, "reviewed"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.openReviewDiff",
      (uri?: vscode.Uri) => openReviewDiff(service, uri),
    ),
    vscode.commands.registerCommand("codeReviewTracker.setup", () =>
      promptForInitialization(service, ignoreRules, true),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.initializeReviewed",
      () => initializeAll(service, ignoreRules, "reviewed"),
    ),
    vscode.commands.registerCommand("codeReviewTracker.initializePending", () =>
      initializeAll(service, ignoreRules, "pending"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.sendSelectionToTerminal",
      () => sendSelection(service),
    ),
    vscode.commands.registerCommand("codeReviewTracker.refresh", async () => {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        await refreshFolder(service, ignoreRules, log, folder, true);
      }
    }),
    vscode.commands.registerCommand("codeReviewTracker.showLogs", () =>
      log.show(),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.ignoreFileForRevExt",
      (uri?: vscode.Uri) => ignoreFileForRevExt(uri),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.ignoreFolderForRevExt",
      (uri?: vscode.Uri) => ignoreFolderForRevExt(uri),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.ignoreExtensionForRevExt",
      (uri?: vscode.Uri) => ignoreExtensionForRevExt(uri),
    ),
  );
}
