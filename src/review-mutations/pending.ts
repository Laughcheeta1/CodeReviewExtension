import type * as vscode from "vscode";
import { initialAdditionHunks } from "../review-service-utils";
import { createRecord, readStableSource } from "../source-io";
import type { ReviewMutationContext } from "./context";

export async function initializePendingFile(
  context: ReviewMutationContext,
  source: vscode.Uri,
): Promise<boolean> {
  const path = context.relativePath(source);
  const store = context.storeFor(source);
  if (
    path === undefined ||
    store === undefined ||
    store.initializationState !== "initialized" ||
    !store.tracksPath(path) ||
    !context.isTrackableUri(source)
  ) {
    throw new Error("This file has not been initialized for review.");
  }
  if (!(await context.isEligibleSource(source))) {
    throw new Error("Ignored files cannot be tracked for review.");
  }
  let { bytes, source: snapshot } = await readStableSource(
    source,
    context.maxSize(),
  );
  const nextRevExtId = await context.annotatePendingDocument(source);
  ({ bytes, source: snapshot } = await readStableSource(
    source,
    context.maxSize(),
  ));
  const baseline = new Uint8Array();
  if (!(await context.isEligibleSource(source))) {
    throw new Error("Ignored files cannot be tracked for review.");
  }
  await store.commit(
    path,
    {
      ...(await createRecord(
        context.git,
        path,
        baseline,
        bytes,
        snapshot,
        undefined,
        initialAdditionHunks(bytes),
      )),
      nextRevExtId,
    },
    baseline,
  );
  context.changedEmitter.fire(source);
  return true;
}
