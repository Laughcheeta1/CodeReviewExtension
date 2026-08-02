import * as vscode from "vscode";
import { GitService } from "./git";
import { ReviewService } from "./review-service";
import type { TrackingTarget } from "./tracking";
import { eligibleWorkspacePaths } from "./workspace-discovery";
import { errorMessage } from "./extension-utils";

/**
 * Run the interactive setup flow for each workspace folder that needs it.
 *
 * The service remains the owner of persistence and eligibility. This module
 * only owns the VS Code prompts, which keeps activation orchestration small
 * while preserving the exact initialization choices and order.
 */
export async function promptForInitialization(
  service: ReviewService,
  git: GitService,
  reconfigure = false,
): Promise<void> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const state = service.initializationState(folder);
    if (!reconfigure && state !== "unconfigured") {
      continue;
    }
    const choice = await vscode.window.showInformationMessage(
      reconfigure
        ? `Set up Code Review Tracker for ${folder.name}? Existing tracking will be replaced.`
        : `Initialize Code Review Tracker for ${folder.name}?`,
      { modal: true },
      reconfigure ? "Set Up Tracking" : "Initialize",
      ...(reconfigure ? [] : ["Never Initialize"]),
    );
    if (choice === "Never Initialize") {
      await service.disableInitialization(folder);
      continue;
    }
    if (choice !== (reconfigure ? "Set Up Tracking" : "Initialize")) {
      continue;
    }
    const paths = await eligibleWorkspacePaths(folder, git);
    const targets = await chooseTrackingTargets(folder, paths);
    if (targets === undefined) {
      continue;
    }
    const status = await vscode.window.showQuickPick(
      [
        {
          label: "Start Reviewed",
          description: "Use the current saved content as the reviewed baseline.",
          status: "reviewed" as const,
        },
        {
          label: "Start Pending",
          description: "Treat every current saved line as pending review.",
          status: "pending" as const,
        },
      ],
      {
        placeHolder: "Choose the initial review state for the selected files.",
      },
    );
    if (status === undefined) {
      continue;
    }
    try {
      await service.initializeFolder(
        folder,
        status.status,
        targets,
        paths,
      );
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
    }
  }
}

interface TrackingItem extends vscode.QuickPickItem {
  readonly target: TrackingTarget;
}

/** Present the preselected, multi-file tracking picker used by setup. */
async function chooseTrackingTargets(
  folder: vscode.WorkspaceFolder,
  paths: readonly string[],
): Promise<readonly TrackingTarget[] | undefined> {
  const items: TrackingItem[] = [...paths]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => ({
      label: path,
      target: { kind: "file", path },
    }));
  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      "There are no eligible files to track in this workspace.",
    );
    return undefined;
  }
  const selectAll: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("check-all"),
    tooltip: "Select all files",
  };
  const deselectAll: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("clear-all"),
    tooltip: "Deselect all files",
  };
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
    });
    picker.onDidTriggerButton((button) => {
      picker.selectedItems = button === selectAll ? items : [];
    });
    picker.onDidAccept(() => {
      if (picker.selectedItems.length === 0) {
        void vscode.window.showWarningMessage(
          "Select at least one file to continue.",
        );
        return;
      }
      accepted = true;
      resolve(picker.selectedItems.map((item) => item.target));
      picker.hide();
    });
    picker.onDidHide(() => {
      if (!accepted) {
        resolve(undefined);
      }
      picker.dispose();
    });
    picker.show();
  });
}
