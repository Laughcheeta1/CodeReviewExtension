import * as vscode from "vscode";
import { registerCommands } from "./extension/commands";
import { registerEventHandlers } from "./extension/events";
import { startupReconcile } from "./extension/startup";
import { watchWorkspace } from "./extension/watchers";
import { GitService } from "./git";
import { GitIgnoreService } from "./git-ignore";
import { promptForInitialization } from "./initialization-setup";
import { openDocumentInReviewView } from "./review-commands/diff-view";
import { ReviewService } from "./review-service";
import { ReviewerCache, ReviewerResolver } from "./reviewer";
import { BaselineContentProvider } from "./ui/content-provider";
import { ReviewDecorations } from "./ui/decorations";
import { ReviewFileDecorations } from "./ui/file-decorations";
import { ReviewTree } from "./ui/tree";
import { runLogged } from "./extension-utils";

export type ExtensionApi = {
  readonly service: ReviewService;
  readonly getStoreDirectory: (
    folder: vscode.WorkspaceFolder,
  ) => vscode.Uri | undefined;
  readonly storageUri: vscode.Uri | undefined;
};

/** Activate the tracker and wire its services to VS Code lifecycle events. */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<ExtensionApi | void> {
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

  const service = new ReviewService(
    log,
    git,
    ignoreRules,
    context.storageUri,
  );
  (globalThis as unknown as Record<string, unknown>).__codeReviewTrackerStorageUri =
    context.storageUri?.toString();
  try {
    await service.initialize();
  } catch (error) {
    log.warn(
      `Review tracking initialization failed; commands remain available: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  context.subscriptions.push(service);

  try {
    await startupReconcile(service, ignoreRules, log);
  } catch (error) {
    log.warn(
      `Review tracking startup reconciliation failed; commands remain available: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

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
  const extensionVersion =
    (context.extension.packageJSON as { version?: string }).version;
  log.info(
    `Code Review Tracker ${extensionVersion ?? "unknown"} activated.`,
  );
  return {
    service,
    storageUri: context.storageUri,
    getStoreDirectory: (folder: vscode.WorkspaceFolder) =>
      service.storeDirectory(folder),
  };
}
