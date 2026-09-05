import type * as vscode from "vscode";
import type { GitService } from "../git";
import type { PersistentStore } from "../store";

export interface BaselineIdentity {
  readonly source: vscode.Uri;
  readonly baselineDigest: string;
  readonly currentDigest: string;
}

export interface ReviewMutationContext {
  readonly git: GitService;
  readonly internalSaves: Set<string>;
  readonly openDocumentForInternalUse: (
    uri: vscode.Uri,
  ) => Promise<vscode.TextDocument>;
  readonly changedEmitter: vscode.EventEmitter<vscode.Uri | undefined>;
  readonly promotedEmitter: vscode.EventEmitter<vscode.Uri>;
  readonly relativePath: (uri: vscode.Uri) => string | undefined;
  readonly storeFor: (uri: vscode.Uri) => PersistentStore | undefined;
  readonly maxSize: () => number;
  readonly isEligibleSource: (uri: vscode.Uri) => Promise<boolean>;
  readonly isTrackableUri: (uri: vscode.Uri) => boolean;
  readonly recompute: (
    uri: vscode.Uri,
    forceDigest: boolean,
    createMissing?: boolean,
  ) => Promise<boolean>;
  readonly annotatePendingDocument: (uri: vscode.Uri) => Promise<number>;
}
