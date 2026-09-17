import type * as vscode from "vscode";
import type { GitService } from "../git";
import type { FileRecord } from "../domain";
import type { PersistentStore } from "../store";
import type { PreparedSource } from "../source-io";

export interface RevExtAnnotationContext {
  readonly git: GitService;
  readonly internalSaves: Set<string>;
  readonly openDocumentForInternalUse: (
    uri: vscode.Uri,
  ) => Promise<vscode.TextDocument>;
  readonly maxSize: () => number;
  readonly isEligibleSource: (uri: vscode.Uri) => Promise<boolean>;
  readonly isRevExtDisabled: (uri: vscode.Uri) => boolean;
  readonly relativePath: (uri: vscode.Uri) => string | undefined;
  readonly storeFor: (uri: vscode.Uri) => PersistentStore | undefined;
  readonly recompute: (
    uri: vscode.Uri,
    forceDigest: boolean,
    createMissing?: boolean,
    prepared?: PreparedSource,
    previous?: FileRecord,
  ) => Promise<boolean>;
}
