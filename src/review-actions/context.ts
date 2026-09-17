import type * as vscode from "vscode";
import type { FileRecord, Reviewer, ReviewStatus } from "../domain";
import type { PersistentStore } from "../store";
import type { BaselineIdentity } from "../review-mutations";

export interface ReviewActionContext {
  readonly parseBaselineUri: (uri: vscode.Uri) => BaselineIdentity | undefined;
  readonly isEligibleSource: (uri: vscode.Uri) => Promise<boolean>;
  readonly initializeMissingSource: (uri: vscode.Uri) => Promise<boolean>;
  readonly withSource: <T>(
    uri: vscode.Uri,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly dirtyDocument: (uri: vscode.Uri) => vscode.TextDocument | undefined;
  readonly requireFresh: (
    uri: vscode.Uri,
    identity?: BaselineIdentity,
  ) => Promise<FileRecord>;
  readonly applyReview: (
    source: vscode.Uri,
    file: FileRecord,
    status: ReviewStatus,
    reviewer: Reviewer | undefined,
    matchesCurrent: (line: FileRecord["currentLines"][number]) => boolean,
    matchesDeleted: (line: FileRecord["deletedLines"][number]) => boolean,
  ) => Promise<boolean>;
  readonly initializePendingFile: (uri: vscode.Uri) => Promise<boolean>;
  readonly storeFor: (uri: vscode.Uri) => PersistentStore | undefined;
  readonly refreshEligiblePaths: (
    folder: vscode.WorkspaceFolder,
    force?: boolean,
  ) => Promise<readonly string[] | undefined>;
}
