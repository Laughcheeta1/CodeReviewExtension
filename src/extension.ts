import * as vscode from "vscode";
import { GitService } from "./git";
import { GitIgnoreService } from "./git-ignore";
import { promptForInitialization } from "./initialization-setup";
import {
  closePromotedDiffTabs,
  initializeAll,
  markActive,
  markFile,
  markFolder,
  openDocumentInReviewView,
  openReviewDiff,
  sendSelection,
} from "./review-commands";
import { ReviewService } from "./review-service";
import { ReviewerCache, ReviewerResolver } from "./reviewer";
import {
  BaselineContentProvider,
  ReviewDecorations,
  ReviewFileDecorations,
  ReviewTree,
} from "./ui";
import { eligibleWorkspacePaths } from "./workspace-discovery";
import { errorMessage, runLogged } from "./extension-utils";

const EXTENSION_VERSION = "0.5.23";

function isReviewDiffDocument(uri: vscode.Uri): boolean {
  return vscode.window.tabGroups.all.some((group) =>
    group.tabs.some(
      (tab) =>
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.original.scheme === "code-review-baseline" &&
        tab.input.modified.toString() === uri.toString(),
    ),
  );
}

function isNormalTextDocumentTab(uri: vscode.Uri): boolean {
  return vscode.window.tabGroups.all.some((group) =>
    group.tabs.some(
      (tab) =>
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.toString() === uri.toString(),
    ),
  );
}

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

  const refreshFolder = async (
    folder: vscode.WorkspaceFolder,
    force = false,
    reconcile = true,
  ): Promise<void> => {
    try {
      const eligible = await eligibleWorkspacePaths(folder, ignoreRules);
      service.setEligiblePaths(folder, eligible);
    } catch (error) {
      log.warn(
        `Could not refresh ignore-rule eligibility for ${folder.uri.fsPath}: ${errorMessage(error)}`,
      );
      return;
    }
    await service.cleanupIgnoredSources(folder);
    if (reconcile) {
      await service.reconcileExternalChanges(folder, force);
    }
  };
  const reconcileCreatedSource = async (uri: vscode.Uri): Promise<void> => {
    await service.reconcileCreatedSource(uri);
  };

  context.subscriptions.push(service);
  await Promise.all(
    vscode.workspace.workspaceFolders.map(async (folder) => {
      await service.cleanupMissingSources(folder);
      await refreshFolder(folder);
      await service.initializeDiscoveredSources(folder);
    }),
  );

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
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (service.isInternalDocumentLoad(document.uri)) {
        return;
      }
      runLogged(
        log,
        "Document loading",
        openDocumentInReviewView(service, document),
      );
    }),
    vscode.workspace.onDidCloseTextDocument((document) =>
      service.forgetInternalDocumentLoad(document.uri),
    ),
    vscode.workspace.onDidSaveTextDocument((document) =>
      runLogged(
        log,
        "Saved-file reconciliation",
        service.reconcileSavedDocument(document),
      ),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration(
          "codeReviewTracker.ignoreEmptyLineDeletions",
        )
      ) {
        return;
      }
      runLogged(
        log,
        "Review policy refresh",
        service.refreshReviewPolicy(),
      );
    }),
    service.onDidPromote((source) =>
      runLogged(
        log,
        "Closing promoted diff tabs",
        closePromotedDiffTabs(source),
      ),
    ),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      decorations.refresh();
      setTimeout(() => {
        for (const editor of vscode.window.visibleTextEditors) {
          if (
            editor.document.uri.scheme !== "file" ||
            isReviewDiffDocument(editor.document.uri) ||
            !isNormalTextDocumentTab(editor.document.uri) ||
            !service.consumeInternalDocumentLoad(editor.document.uri)
          ) {
            continue;
          }
          runLogged(
            log,
            "Manually opened document",
            openDocumentInReviewView(service, editor.document),
          );
        }
      }, 0);
    }),
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
        await refreshFolder(folder, true);
      }
    }),
    vscode.commands.registerCommand("codeReviewTracker.showLogs", () =>
      log.show(),
    ),
  );

  for (const folder of vscode.workspace.workspaceFolders) {
    const pattern = new vscode.RelativePattern(folder, "**/*");
    const watcher = vscode.workspace.createFileSystemWatcher(
      pattern,
      false,
      false,
      false,
    );
    const creation = watcher.onDidCreate((uri) =>
      runLogged(
        log,
        "Source creation",
        reconcileCreatedSource(uri),
      ),
    );
    const deletion = watcher.onDidDelete((uri) =>
      service.hideSources([uri]),
    );
    const change = watcher.onDidChange((uri) =>
      runLogged(
        log,
        "External-file reconciliation",
        service.reconcileExternalSource(uri),
      ),
    );
    const gitIgnoreWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, "**/.gitignore"),
    );
    let ignoreRefresh: Promise<void> | undefined;
    const refreshIgnoredPaths = () => {
      if (ignoreRefresh === undefined) {
        ignoreRefresh = (async () => {
          await refreshFolder(folder, false, false);
          await service.initializeDiscoveredSources(folder);
        })().finally(() => {
          ignoreRefresh = undefined;
        });
      }
      runLogged(log, "Ignore-rule refresh", ignoreRefresh);
    };
    context.subscriptions.push(
      watcher,
      creation,
      deletion,
      change,
      gitIgnoreWatcher,
      gitIgnoreWatcher.onDidCreate(refreshIgnoredPaths),
      gitIgnoreWatcher.onDidChange(refreshIgnoredPaths),
      gitIgnoreWatcher.onDidDelete(refreshIgnoredPaths),
    );
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
