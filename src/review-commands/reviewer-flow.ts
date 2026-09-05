import * as vscode from "vscode";
import type { Reviewer } from "../domain";
import type { ReviewerResolver } from "../reviewer";

export async function resolveReviewer(
  resolver: ReviewerResolver,
  uri: vscode.Uri | undefined,
): Promise<Reviewer | undefined> {
  const folder =
    uri === undefined ? undefined : vscode.workspace.getWorkspaceFolder(uri);
  const workspaceKey = folder?.uri.toString() ?? "global";
  const directory = folder?.uri.fsPath;
  return resolver.resolve(workspaceKey, directory, async () => {
    return configuredReviewer(uri);
  });
}

async function configuredReviewer(
  uri: vscode.Uri | undefined,
): Promise<Reviewer | undefined> {
  const config = vscode.workspace.getConfiguration("codeReviewTracker", uri);
  const configuredName = config.get<string>("reviewerName", "").trim();
  const configuredEmail = config.get<string>("reviewerEmail", "").trim();
  let name = configuredName;
  let email = configuredEmail;
  if (name.length === 0) {
    name = (await vscode.window.showInputBox({
      prompt: "Reviewer name",
      ignoreFocusOut: true,
    }))?.trim() ?? "";
  }
  if (name.length === 0) {
    return undefined;
  }
  if (email.length === 0) {
    email = (await vscode.window.showInputBox({
      prompt: "Reviewer email (optional)",
      ignoreFocusOut: true,
    }))?.trim() ?? "";
  }
  if (configuredName.length === 0) {
    await config.update(
      "reviewerName",
      name,
      vscode.ConfigurationTarget.Global,
    );
  }
  if (email.length > 0 && configuredEmail.length === 0) {
    await config.update(
      "reviewerEmail",
      email,
      vscode.ConfigurationTarget.Global,
    );
  }
  return email.length > 0 ? { name, email } : { name };
}
