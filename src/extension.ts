import * as vscode from "vscode";
import { GitService } from "./git";
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
import {
  BaselineContentProvider,
  ReviewDecorations,
  ReviewFileDecorations,
  ReviewTree,
} from "./ui";
import { eligibleWorkspacePaths } from "./workspace-discovery";
import { runLogged } from "./extension-utils";

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
  if (!(await git.gitAvailable())) {
    log.warn(
      "Git is unavailable. Tracking is paused in Git workspaces until .gitignore rules can be evaluated.",
    );
  }

  const service = new ReviewService(log, git);
  await service.initialize();

  const refreshFolder = async (
    folder: vscode.WorkspaceFolder,
    force = false,
  ): Promise<void> => {
    const eligible = await eligibleWorkspacePaths(folder, git);
    if (eligible !== undefined) {
      service.setEligiblePaths(folder, eligible);
    }
    await service.cleanupIgnoredSources(folder);
    await service.reconcileExternalChanges(folder, force);
  };
  const reconcileCreatedSource = async (
    folder: vscode.WorkspaceFolder,
    uri: vscode.Uri,
  ): Promise<void> => {
    const path = vscode.workspace
      .asRelativePath(uri, false)
      .replaceAll("\\", "/");
    try {
      if ((await git.ignoredPaths(folder.uri.fsPath, [path])).has(path)) {
        return;
      }
    } catch {
      return;
    }
    await service.reconcileCreatedSource(uri);
  };

  context.subscriptions.push(service);
  for (const folder of vscode.workspace.workspaceFolders) {
    await service.cleanupMissingSources(folder);
    await refreshFolder(folder);
    await service.initializeDiscoveredSources(folder);
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
    vscode.workspace.onDidOpenTextDocument((document) =>
      runLogged(
        log,
        "Document loading",
        openDocumentInReviewView(service, document),
      ),
    ),
    vscode.workspace.onDidSaveTextDocument((document) =>
      runLogged(
        log,
        "Saved-file reconciliation",
        service.reconcileSavedDocument(document),
      ),
    ),
    service.onDidPromote((source) =>
      runLogged(
        log,
        "Closing promoted diff tabs",
        closePromotedDiffTabs(source),
      ),
    ),
    vscode.window.onDidChangeVisibleTextEditors(() => decorations.refresh()),
    vscode.commands.registerCommand("codeReviewTracker.markPending", () =>
      markActive(service, git, "pending"),
    ),
    vscode.commands.registerCommand("codeReviewTracker.markInReview", () =>
      markActive(service, git, "inReview"),
    ),
    vscode.commands.registerCommand("codeReviewTracker.markReviewed", () =>
      markActive(service, git, "reviewed"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.markFilePending",
      (uri?: vscode.Uri) => markFile(service, git, uri, "pending"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.markFileInReview",
      (uri?: vscode.Uri) => markFile(service, git, uri, "inReview"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.markFileReviewed",
      (uri?: vscode.Uri) => markFile(service, git, uri, "reviewed"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.markFolderPending",
      (uri?: vscode.Uri) => markFolder(service, git, uri, "pending"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.markFolderInReview",
      (uri?: vscode.Uri) => markFolder(service, git, uri, "inReview"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.markFolderReviewed",
      (uri?: vscode.Uri) => markFolder(service, git, uri, "reviewed"),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.openReviewDiff",
      (uri?: vscode.Uri) => openReviewDiff(service, uri),
    ),
    vscode.commands.registerCommand("codeReviewTracker.setup", () =>
      promptForInitialization(service, git, true),
    ),
    vscode.commands.registerCommand(
      "codeReviewTracker.initializeReviewed",
      () => initializeAll(service, git, "reviewed"),
    ),
    vscode.commands.registerCommand("codeReviewTracker.initializePending", () =>
      initializeAll(service, git, "pending"),
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
      true,
      false,
    );
    const creation = watcher.onDidCreate((uri) =>
      runLogged(
        log,
        "Source creation",
        reconcileCreatedSource(folder, uri),
      ),
    );
    const deletion = watcher.onDidDelete((uri) =>
      service.hideSources([uri]),
    );
    const gitIgnoreWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, "**/.gitignore"),
    );
    const refreshIgnoredPaths = () =>
      runLogged(log, "Git ignore refresh", refreshFolder(folder));
    context.subscriptions.push(
      watcher,
      creation,
      deletion,
      gitIgnoreWatcher,
      gitIgnoreWatcher.onDidCreate(refreshIgnoredPaths),
      gitIgnoreWatcher.onDidChange(refreshIgnoredPaths),
      gitIgnoreWatcher.onDidDelete(refreshIgnoredPaths),
    );
  }

  for (const editor of vscode.window.visibleTextEditors) {
    await openDocumentInReviewView(service, editor.document);
  }
  runLogged(log, "Initialization prompt", promptForInitialization(service, git));
  decorations.refresh();
  log.info("Code Review Tracker 0.5.1 activated.");
}
