import type * as vscode from "vscode";
import type { FileRecord } from "../domain";
import type { BaselineIdentity, ReviewMutationContext } from "./context";

export async function requireFresh(
  context: ReviewMutationContext,
  source: vscode.Uri,
  identity?: BaselineIdentity,
  forceDigest = true,
): Promise<FileRecord> {
  await context.recompute(source, forceDigest);
  const path = context.relativePath(source);
  const file =
    path === undefined ? undefined : await context.storeFor(source)?.load(path);
  if (file === undefined) {
    throw new Error("This file has not been initialized for review.");
  }
  // The baseline URI's current digest identifies the saved generation that
  // was open when the native diff was created. The modified side is live, so
  // a later saved edit legitimately advances that digest while the baseline
  // remains authoritative. Recompute above supplies the latest saved record;
  // line-level callers must still match their selection against that record.
  if (
    identity !== undefined &&
    identity.baselineDigest !== file.baseline.digest
  ) {
    throw new Error(
      "This review diff is stale. Reopen Code Review: Open Review Diff.",
    );
  }
  return file;
}
