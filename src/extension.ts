import * as vscode from "vscode";
import { registerCommands } from "./extension/commands";
import { registerEventHandlers } from "./extension/events";
import { startupReconcile } from "./extension/startup";
import { watchWorkspace } from "./extension/watchers";
import { GitService } from "./git";
import { GitIgnoreService } from "./git-ignore";
import { promptForInitialization } from "./initialization-setup";
import { openDocumentInReviewView } from "./review-commands";
import { ReviewService } from "./review-service";
import { ReviewerCache, ReviewerResolver } from "./reviewer";
import {
  BaselineContentProvider,
  ReviewDecorations,
  ReviewFileDecorations,
  ReviewTree,
} from "./ui";
import { runLogged } from "./extension-utils";

const EXTENSION_VERSION = "0.5.24";

/** Activate the tracker and wire its services to VS Code lifecycle events. */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const log = vscode.window.createOutputChannel("Code Review Tracker", {
    log: true,
  });
  context.subscriptions.push(log);

  if (vscode.workspace.workspaceFolders === undefined) {
    log.info("No workspace folder is open.");
    return;
  }

  const git = new GitService();
  const reviewerResolver = new ReviewerResolver(
    git,
    new ReviewerCache(context.globalState),
  );
  const ignoreRules = new GitIgnoreService();

  const service = new ReviewService(log, git, ignoreRules);
  await service.initialize();
  context.subscriptions.push(service);

  await startupReconcile(service, ignoreRules, log);

  const decorations = new ReviewDecorations(service);
  const tree = new ReviewTree(service);
  const fileDecorations = new ReviewFileDecorations(service);
  context.subscriptions.push(decorations, tree, fileDecorations);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "code-review-baseline",
      new BaselineContentProvider(service),
    ),
    vscode.window.registerTreeDataProvider("codeReviewTracker.files", tree),
    vscode.window.registerFileDecorationProvider(fileDecorations),
  );
  registerEventHandlers(context, service, log, decorations);
  registerCommands(context, service, reviewerResolver, ignoreRules, log);

  for (const folder of vscode.workspace.workspaceFolders) {
    watchWorkspace(context, folder, service, ignoreRules, log);
  }

  for (const editor of vscode.window.visibleTextEditors) {
    await openDocumentInReviewView(service, editor.document);
  }
  runLogged(
    log,
    "Initialization prompt",
    promptForInitialization(service, ignoreRules),
  );
  decorations.refresh();
  log.info(
    `Code Review Tracker ${EXTENSION_VERSION} activated.`,
  );
}
