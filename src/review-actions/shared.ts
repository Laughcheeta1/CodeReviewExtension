import type * as vscode from "vscode";
import type { FileRecord } from "../domain";
import type { BaselineIdentity } from "../review-mutations";
import type { ReviewActionContext } from "./context";

/**
 * Shared prelude for single-source review actions: ignore guard, lazy
 * initialization, per-source serialization, dirty-editor rejection, and a
 * forced fresh read of the latest saved generation.
 */
export async function withFreshFile<T>(
  context: ReviewActionContext,
  source: vscode.Uri,
  identity: BaselineIdentity | undefined,
  operation: (file: FileRecord) => Promise<T>,
): Promise<T> {
  if (!(await context.isEligibleSource(source))) {
    throw new Error("Ignored files cannot be tracked for review.");
  }
  await context.initializeMissingSource(source);
  return context.withSource(source, async () => {
    if (context.dirtyDocument(source) !== undefined) {
      throw new Error("Save the file before changing review state.");
    }
    const file = await context.requireFresh(source, identity);
    return operation(file);
  });
}
