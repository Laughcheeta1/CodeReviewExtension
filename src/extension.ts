import * as vscode from "vscode";
import { terminalPayload, type ReviewStatus, type Reviewer } from "./domain";
import { GitService } from "./git";
import { ReviewService } from "./review-service";
import type { TrackingTarget } from "./tracking";
import {
  BaselineContentProvider,
  ReviewCodeLensProvider,
  ReviewDecorations,
  ReviewFileDecorations,
  ReviewTree,
  type HunkCommand,
} from "./ui";
// RevExt: 191
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {  // RevExt: 205
  const log = vscode.window.createOutputChannel("Code Review Tracker", {
    log: true,
  });  // RevExt: 384
// RevExt: 192
  context.subscriptions.push(log);
  if (vscode.workspace.workspaceFolders === undefined) {
    log.info("No workspace folder is open.");
    return;  // RevExt: 210
  }  // RevExt: 219
  const git = new GitService();
  if (!(await git.gitAvailable())) {
    void vscode.window.showErrorMessage(
      "Code Review Tracker requires the Git executable for baseline diffs.",
    );  // RevExt: 245
    return;  // RevExt: 211
  }  // RevExt: 220
  const service = new ReviewService(log, git);
  await service.initialize();
  const refreshFolder = async (
    folder: vscode.WorkspaceFolder,  // RevExt: 257
    force = false,
  ): Promise<void> => {  // RevExt: 259
    service.setEligiblePaths(folder, await eligibleWorkspacePaths(folder, git));
    await service.reconcileExternalChanges(folder, force);
  };  // RevExt: 261
  const reconcileCreatedSource = async (
    folder: vscode.WorkspaceFolder,  // RevExt: 258
    uri: vscode.Uri,
  ): Promise<void> => {  // RevExt: 260
    const path = vscode.workspace
      .asRelativePath(uri, false)
      .replaceAll("\\", "/");
    if ((await git.ignoredPaths(folder.uri.fsPath, [path])).has(path)) {
      return;  // RevExt: 263
    }  // RevExt: 266
    await service.reconcileCreatedSource(uri);
  };  // RevExt: 262
// RevExt: 193
  context.subscriptions.push(service);
  for (const folder of vscode.workspace.workspaceFolders) {  // RevExt: 277
    await service.cleanupMissingSources(folder);
    await refreshFolder(folder);
  }  // RevExt: 221
// RevExt: 194
  const decorations = new ReviewDecorations(service);
  const codeLens = new ReviewCodeLensProvider(service);
  const tree = new ReviewTree(service);
  const fileDecorations = new ReviewFileDecorations(service);
// RevExt: 195
  context.subscriptions.push(  // RevExt: 279
    decorations,
    codeLens,
    tree,
    fileDecorations,
  );  // RevExt: 281
  context.subscriptions.push(  // RevExt: 280
    vscode.workspace.registerTextDocumentContentProvider(
      "code-review-baseline",
      new BaselineContentProvider(service),
    ),  // RevExt: 290
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file" }, { scheme: "code-review-baseline" }],
      codeLens,
    ),  // RevExt: 291
    vscode.window.registerTreeDataProvider("codeReviewTracker.files", tree),
    vscode.window.registerFileDecorationProvider(fileDecorations),
    vscode.workspace.onDidOpenTextDocument((document) =>
      runLogged(log, "Document loading", service.ensureDocument(document)),
    ),  // RevExt: 292
    vscode.workspace.onDidSaveTextDocument((document) =>
      runLogged(  // RevExt: 305
        log,  // RevExt: 308
        "Saved-file reconciliation",
        service.reconcileSavedDocument(document),
      ),  // RevExt: 311
    ),  // RevExt: 293
    service.onDidPromote((source) =>
      runLogged(  // RevExt: 306
        log,  // RevExt: 309
        "Closing promoted diff tabs",
        closePromotedDiffTabs(source),
      ),  // RevExt: 312
    ),  // RevExt: 294
    vscode.window.onDidChangeVisibleTextEditors(() => decorations.refresh()),
    vscode.commands.registerCommand("codeReviewTracker.markPending", () =>
      markActive(service, git, "pending"),
    ),  // RevExt: 295
    vscode.commands.registerCommand("codeReviewTracker.markInReview", () =>
      markActive(service, git, "inReview"),
    ),  // RevExt: 296
    vscode.commands.registerCommand("codeReviewTracker.markReviewed", () =>
      markActive(service, git, "reviewed"),
    ),  // RevExt: 297
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
    vscode.commands.registerCommand(  // RevExt: 314
      "codeReviewTracker.markHunkPending",
      (command: HunkCommand) => markHunk(service, git, command),  // RevExt: 319
    ),  // RevExt: 298
    vscode.commands.registerCommand(  // RevExt: 315
      "codeReviewTracker.markHunkReviewed",
      (command: HunkCommand) => markHunk(service, git, command),  // RevExt: 320
    ),  // RevExt: 299
    vscode.commands.registerCommand(  // RevExt: 316
      "codeReviewTracker.openReviewDiff",
      (uri?: vscode.Uri) => openReviewDiff(service, uri),
    ),  // RevExt: 300
    vscode.commands.registerCommand("codeReviewTracker.setup", () =>
      promptForInitialization(service, git, true),
    ),  // RevExt: 399
    vscode.commands.registerCommand(  // RevExt: 317
      "codeReviewTracker.initializeReviewed",
      () => initializeAll(service, git, "reviewed"),
    ),  // RevExt: 301
    vscode.commands.registerCommand("codeReviewTracker.initializePending", () =>
      initializeAll(service, git, "pending"),
    ),  // RevExt: 302
    vscode.commands.registerCommand(  // RevExt: 318
      "codeReviewTracker.sendSelectionToTerminal",
      () => sendSelection(service),
    ),  // RevExt: 303
    vscode.commands.registerCommand("codeReviewTracker.refresh", async () => {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        await refreshFolder(folder, true);
      }  // RevExt: 400
    }),
    vscode.commands.registerCommand("codeReviewTracker.showLogs", () =>
      log.show(),
    ),  // RevExt: 304
  );  // RevExt: 282
// RevExt: 196
  for (const folder of vscode.workspace.workspaceFolders) {  // RevExt: 278
    const pattern = new vscode.RelativePattern(folder, "**/*");
    const watcher = vscode.workspace.createFileSystemWatcher(
      pattern,
      false,  // RevExt: 321
      true,
      false,  // RevExt: 322
    );  // RevExt: 246
// RevExt: 197
    const creation = watcher.onDidCreate((uri) =>
      runLogged(  // RevExt: 307
        log,  // RevExt: 310
        "Source creation",
        reconcileCreatedSource(folder, uri),
      ),  // RevExt: 313
    );  // RevExt: 247
    const deletion = watcher.onDidDelete((uri) =>
      service.hideSources([uri]),
    );  // RevExt: 248
// RevExt: 198
    const gitIgnoreWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, "**/.gitignore"),
    );  // RevExt: 249
    const refreshIgnoredPaths = () =>
      runLogged(log, "Git ignore refresh", refreshFolder(folder));
// RevExt: 199
    context.subscriptions.push(
      watcher,
      creation,
      deletion,
      gitIgnoreWatcher,
      gitIgnoreWatcher.onDidCreate(refreshIgnoredPaths),
      gitIgnoreWatcher.onDidChange(refreshIgnoredPaths),
      gitIgnoreWatcher.onDidDelete(refreshIgnoredPaths),
    );  // RevExt: 250
  }  // RevExt: 222
// RevExt: 200
  for (const editor of vscode.window.visibleTextEditors) {
    await service.ensureDocument(editor.document);
  }  // RevExt: 223
  runLogged(log, "Initialization prompt", promptForInitialization(service, git));
  decorations.refresh();
  log.info("Code Review Tracker 0.4.0 activated.");
}  // RevExt: 323
// RevExt: 201
async function promptForInitialization(
  service: ReviewService,  // RevExt: 404
  git: GitService,  // RevExt: 405
  reconfigure = false,
): Promise<void> {  // RevExt: 383
  for (const folder of vscode.workspace.workspaceFolders ?? []) {  // RevExt: 336
    const state = service.initializationState(folder);
    if (!reconfigure && state !== "unconfigured") {
      continue;  // RevExt: 407
    }  // RevExt: 267
    const choice = await vscode.window.showInformationMessage(
      reconfigure
        ? `Set up Code Review Tracker for ${folder.name}? Existing tracking will be replaced.`
        : `Initialize Code Review Tracker for ${folder.name}?`,
      { modal: true },
      reconfigure ? "Set Up Tracking" : "Initialize",
      ...(reconfigure ? [] : ["Never Initialize"]),
    );  // RevExt: 251
    if (choice === "Never Initialize") {
      await service.disableInitialization(folder);
      continue;  // RevExt: 408
    }  // RevExt: 394
    if (choice !== (reconfigure ? "Set Up Tracking" : "Initialize")) {
      continue;  // RevExt: 409
    }  // RevExt: 395
    const paths = await eligibleWorkspacePaths(folder, git);
    const targets = await chooseTrackingTargets(folder, paths);
    if (targets === undefined) {
      continue;  // RevExt: 410
    }  // RevExt: 396
    const status = await vscode.window.showQuickPick(
      [
        {  // RevExt: 412
          label: "Start Reviewed",
          description: "Use the current saved content as the reviewed baseline.",
          status: "reviewed" as const,
        },  // RevExt: 414
        {  // RevExt: 413
          label: "Start Pending",
          description: "Treat every current saved line as pending review.",
          status: "pending" as const,
        },  // RevExt: 415
      ],
      {
        placeHolder: "Choose the initial review state for the selected files.",
      },
    );  // RevExt: 390
    if (status === undefined) {
      continue;  // RevExt: 411
    }  // RevExt: 397
    try {  // RevExt: 416
      await service.initializeFolder(  // RevExt: 418
        folder,  // RevExt: 420
        status.status,
        targets,
        paths,  // RevExt: 422
      );  // RevExt: 424
    } catch (error) {  // RevExt: 426
      void vscode.window.showErrorMessage(errorMessage(error));  // RevExt: 428
    }  // RevExt: 269
  }  // RevExt: 224
}  // RevExt: 324
async function chooseTrackingTargets(
  folder: vscode.WorkspaceFolder,  // RevExt: 430
  paths: readonly string[],
): Promise<readonly TrackingTarget[] | undefined> {
  interface TrackingItem extends vscode.QuickPickItem {
    readonly target: TrackingTarget;
  }  // RevExt: 386
  const items: TrackingItem[] = [...paths]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => ({
      label: path,
      target: { kind: "file", path },
    }));
  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      "There are no eligible files to track in this workspace.",
    );  // RevExt: 391
    return undefined;  // RevExt: 432
  }  // RevExt: 387
  const selectAll: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("check-all"),
    tooltip: "Select all files",
  };  // RevExt: 392
  const deselectAll: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("clear-all"),
    tooltip: "Deselect all files",
  };  // RevExt: 393
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick<TrackingItem>();
    let accepted = false;
    picker.canSelectMany = true;
    picker.items = items;
    picker.selectedItems = items;
    picker.buttons = [selectAll, deselectAll];
    picker.title = `Choose files to track in ${folder.name}`;
    picker.placeholder = `${items.length}/${items.length} files selected`;
    picker.onDidChangeSelection((selected) => {
      picker.placeholder = `${selected.length}/${items.length} files selected`;
    });  // RevExt: 434
    picker.onDidTriggerButton((button) => {
      picker.selectedItems = button === selectAll ? items : [];
    });  // RevExt: 435
    picker.onDidAccept(() => {
      if (picker.selectedItems.length === 0) {
        void vscode.window.showWarningMessage(
          "Select at least one file to continue.",
        );
        return;
      }  // RevExt: 401
      accepted = true;
      resolve(picker.selectedItems.map((item) => item.target));
      picker.hide();
    });  // RevExt: 436
    picker.onDidHide(() => {
      if (!accepted) {
        resolve(undefined);
      }  // RevExt: 402
      picker.dispose();
    });  // RevExt: 437
    picker.show();
  });  // RevExt: 385
}  // RevExt: 403
// RevExt: 202
async function openReviewDiff(
  service: ReviewService,  // RevExt: 338
  uri?: vscode.Uri,  // RevExt: 342
): Promise<void> {  // RevExt: 206
  const requested = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (requested === undefined) {
    return;  // RevExt: 212
  }  // RevExt: 225
  const source = service.parseBaselineUri(requested)?.source ?? requested;
  try {  // RevExt: 344
    const prepared = await service.prepareDiff(source);
    if (prepared === undefined) {
      void vscode.window.showInformationMessage(  // RevExt: 347
        "Initialize this workspace before opening review diffs.",
      );  // RevExt: 349
      return;  // RevExt: 264
    }  // RevExt: 270
    if (prepared.file.hunks.length === 0) {
      await vscode.window.showTextDocument(source);
      return;  // RevExt: 265
    }  // RevExt: 271
    const path = service.relativePath(source) ?? source.path;
    await vscode.commands.executeCommand(
      "vscode.diff",
      prepared.baseline,
      source,
      `Code Review: ${path}`,
    );  // RevExt: 252
  } catch (error) {  // RevExt: 351
    void vscode.window.showWarningMessage(errorMessage(error));  // RevExt: 354
  }  // RevExt: 226
}  // RevExt: 325
// RevExt: 203
async function closePromotedDiffTabs(source: vscode.Uri): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    const stale = group.tabs.filter(
      (tab) =>
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.original.scheme === "code-review-baseline" &&
        tab.input.modified.toString() === source.toString(),
    );  // RevExt: 253
    if (stale.length > 0) {
      await vscode.window.tabGroups.close(stale, true);
    }  // RevExt: 272
  }  // RevExt: 227
}  // RevExt: 326
// RevExt: 204
async function reviewer(
  git: GitService,  // RevExt: 357
  uri?: vscode.Uri,  // RevExt: 343
): Promise<Reviewer | undefined> {
  const fromGit = await git.reviewer(
    uri === undefined ? undefined : vscode.workspace.getWorkspaceFolder(uri),
  );  // RevExt: 283
  if (fromGit !== undefined) {
    return fromGit;
  }  // RevExt: 228
  const config = vscode.workspace.getConfiguration("codeReviewTracker");
  const configuredName = config.get<string>("reviewerName", "").trim();
  const configuredEmail = config.get<string>("reviewerEmail", "").trim();
  let name = configuredName;
  let email = configuredEmail;
  if (name.length === 0) {  // RevExt: 361
    name =
      (  // RevExt: 363
        await vscode.window.showInputBox({  // RevExt: 365
          prompt: "Reviewer name",
          ignoreFocusOut: true,  // RevExt: 367
        })  // RevExt: 369
      )?.trim() ?? "";  // RevExt: 371
  }  // RevExt: 229
  if (name.length === 0) {  // RevExt: 362
    return undefined;  // RevExt: 433
  }  // RevExt: 230
  if (email.length === 0) {
    email =
      (  // RevExt: 364
        await vscode.window.showInputBox({  // RevExt: 366
          prompt: "Reviewer email (optional)",
          ignoreFocusOut: true,  // RevExt: 368
        })  // RevExt: 370
      )?.trim() ?? "";  // RevExt: 372
  }  // RevExt: 231
  if (configuredName.length === 0) {
    await config.update(  // RevExt: 373
      "reviewerName",
      name,
      vscode.ConfigurationTarget.Global,  // RevExt: 375
    );  // RevExt: 254
  }  // RevExt: 232
  if (email.length > 0 && configuredEmail.length === 0) {
    await config.update(  // RevExt: 374
      "reviewerEmail",
      email,
      vscode.ConfigurationTarget.Global,  // RevExt: 376
    );  // RevExt: 255
  }  // RevExt: 233
  return email.length > 0 ? { name, email } : { name };
}  // RevExt: 327
async function markActive(
  service: ReviewService,  // RevExt: 339
  git: GitService,  // RevExt: 358
  status: ReviewStatus,
): Promise<void> {  // RevExt: 207
  const editor = vscode.window.activeTextEditor;  // RevExt: 377
  if (editor === undefined) {
    return;  // RevExt: 213
  }  // RevExt: 234
  const source =
    service.parseBaselineUri(editor.document.uri)?.source ??
    editor.document.uri;
  const identity =  // RevExt: 379
    status === "pending" ? undefined : await reviewer(git, source);
  if (status !== "pending" && identity === undefined) {
    return;  // RevExt: 214
  }  // RevExt: 235
  try {  // RevExt: 345
    if (!(await service.markEditor(editor, status, identity))) {
      void vscode.window.showInformationMessage(  // RevExt: 348
        "The selection contains no reviewable changes.",
      );  // RevExt: 350
    }  // RevExt: 273
  } catch (error) {  // RevExt: 352
    void vscode.window.showWarningMessage(errorMessage(error));  // RevExt: 355
  }  // RevExt: 236
}  // RevExt: 328
async function markHunk(
  service: ReviewService,  // RevExt: 340
  git: GitService,  // RevExt: 359
  command: HunkCommand | undefined,
): Promise<void> {  // RevExt: 208
  if (command === undefined) {
    return;  // RevExt: 215
  }  // RevExt: 237
  const identity =  // RevExt: 380
    command.status === "pending"
      ? undefined
      : await reviewer(git, command.source);
  if (command.status !== "pending" && identity === undefined) {
    return;  // RevExt: 216
  }  // RevExt: 238
  try {  // RevExt: 346
    await service.markHunk(
      command.source,
      command.baselineDigest,
      command.currentDigest,
      command.hunkIndex,
      command.status,
      identity,
    );  // RevExt: 256
  } catch (error) {  // RevExt: 353
    void vscode.window.showWarningMessage(errorMessage(error));  // RevExt: 356
  }  // RevExt: 239
}  // RevExt: 329
async function markFile(
  service: ReviewService,
  git: GitService,
  uri: vscode.Uri | undefined,
  status: ReviewStatus,
): Promise<void> {
  if (uri === undefined || uri.scheme !== "file") {
    return;
  }
  const identity = status === "pending" ? undefined : await reviewer(git, uri);
  if (status !== "pending" && identity === undefined) {
    return;
  }
  try {
    if (!(await service.markFile(uri, status, identity))) {
      void vscode.window.showInformationMessage(
        "The file contains no reviewable changes.",
      );
    }
  } catch (error) {
    void vscode.window.showWarningMessage(errorMessage(error));
  }
}
async function initializeAll(
  service: ReviewService,  // RevExt: 341
  git: GitService,  // RevExt: 406
  status: "pending" | "reviewed",
): Promise<void> {  // RevExt: 209
  for (const folder of vscode.workspace.workspaceFolders ?? []) {  // RevExt: 337
    try {  // RevExt: 417
      const paths = await eligibleWorkspacePaths(folder, git);
      await service.initializeFolder(  // RevExt: 419
        folder,  // RevExt: 421
        status,
        [{ kind: "folder", path: "" }],
        paths,  // RevExt: 423
      );  // RevExt: 425
    } catch (error) {  // RevExt: 427
      void vscode.window.showErrorMessage(errorMessage(error));  // RevExt: 429
    }  // RevExt: 274
  }  // RevExt: 240
}  // RevExt: 330
function selectionRanges(editor: vscode.TextEditor): readonly {
  start: number;
  end: number;
}[] {
  const unique = new Map<
    string,
    {
      start: number;
      end: number;
    }  // RevExt: 275
  >();
  for (const selection of editor.selections) {
    const start = selection.isEmpty
      ? selection.active.line
      : selection.start.line;
    const end = selection.isEmpty ? start : selection.end.line;
    unique.set(`${start}:${end}`, { start, end });
  }  // RevExt: 241
  return [...unique.values()].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );  // RevExt: 284
}  // RevExt: 331
function sendSelection(service: ReviewService): void {
  const editor = vscode.window.activeTextEditor;  // RevExt: 378
  if (editor === undefined || editor.document.uri.scheme !== "file") {
    return;  // RevExt: 217
  }  // RevExt: 242
  const path = service.relativePath(editor.document.uri);
  if (path === undefined) {
    return;  // RevExt: 218
  }  // RevExt: 243
  const payload = terminalPayload(
    path,
    editor.document.getText(),
    selectionRanges(editor),
  );  // RevExt: 285
  let terminal = vscode.window.activeTerminal;
  if (terminal === undefined) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    terminal =
      folder === undefined
        ? vscode.window.createTerminal({ name: "Code Review Agent" })
        : vscode.window.createTerminal({
            name: "Code Review Agent",
            cwd: folder.uri,
          });
    terminal.show(true);
    const command = vscode.workspace
      .getConfiguration("codeReviewTracker")
      .get<string>("agentCommand", "")
      .trim();
    if (command.length > 0 && vscode.workspace.isTrusted) {
      terminal.sendText(command, true);
    }  // RevExt: 276
  }  // RevExt: 244
  terminal.sendText(payload, false);
}  // RevExt: 332
async function eligibleWorkspacePaths(
  folder: vscode.WorkspaceFolder,  // RevExt: 431
  git: GitService,  // RevExt: 360
): Promise<readonly string[]> {
  const excluded = new vscode.RelativePattern(
    folder,
    "**/{.git,node_modules,.vscode/code-review-tracker}/**",
  );  // RevExt: 286
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, "**/*"),
    excluded,  // RevExt: 438
  );  // RevExt: 287
  const paths = uris.map((uri) =>
    vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/"),
  );  // RevExt: 288
  const ignoreFiles = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, "**/.gitignore"),
    excluded,  // RevExt: 439
  );  // RevExt: 398
  if (ignoreFiles.length === 0) {
    return paths;
  }  // RevExt: 388
  const tracked = await git.trackedPaths(folder.uri.fsPath);
  if (tracked !== undefined) {
    const available = new Set(paths);
    return tracked.filter((path) => available.has(path));
  }  // RevExt: 389
  const ignored = await git.ignoredPaths(folder.uri.fsPath, paths);
  return paths.filter((path) => !ignored.has(path));
}  // RevExt: 333
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}  // RevExt: 334
function runLogged(
  log: vscode.LogOutputChannel,
  action: string,
  operation: Promise<unknown>,
): void {
  void operation.catch((error) =>
    log.warn(`${action} failed: ${errorMessage(error)}`),
  );  // RevExt: 289
}  // RevExt: 335
// RevExt: 381
// RevExt: 382
