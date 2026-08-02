import * as vscode from "vscode";

/** Convert an unknown command/lifecycle failure into a user-readable message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
