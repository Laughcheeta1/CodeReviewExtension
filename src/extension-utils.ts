import * as vscode from "vscode";
import { errorMessage } from "./errors";

export { errorMessage };

/** Run a background extension operation without creating an unhandled rejection. */
export function runLogged(
  log: vscode.LogOutputChannel,
  action: string,
  operation: Promise<unknown>,
): void {
  void operation.catch((error) =>
    log.warn(`${action} failed: ${errorMessage(error)}`),
  );
}
