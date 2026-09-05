import * as vscode from "vscode";
import { coalesced, serialized } from "../concurrency";

/**
 * Serializes per-source operations and coalesces duplicate loads so
 * asynchronous VS Code events cannot commit conflicting generations.
 * Also guards workspace initialization against concurrent source work.
 */
export class SourceGate {
  private readonly sourceTails = new Map<string, Promise<unknown>>();
  private readonly ensureTails = new Map<string, Promise<void>>();
  private readonly initializingFolders = new Set<string>();

  async withSource<T>(
    uri: vscode.Uri,
    operation: () => Promise<T>,
  ): Promise<T> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (
      folder !== undefined &&
      this.initializingFolders.has(folder.uri.toString())
    ) {
      throw new Error("Workspace review initialization is in progress.");
    }
    return serialized(this.sourceTails, uri.toString(), operation);
  }

  ensureDocumentLoad(key: string, load: () => Promise<void>): Promise<void> {
    return coalesced(this.ensureTails, key, load);
  }

  tryBeginInitialization(folder: vscode.WorkspaceFolder): boolean {
    const key = folder.uri.toString();
    if (this.initializingFolders.has(key)) {
      return false;
    }
    this.initializingFolders.add(key);
    return true;
  }

  endInitialization(folder: vscode.WorkspaceFolder): void {
    this.initializingFolders.delete(folder.uri.toString());
  }

  async drainSources(): Promise<void> {
    await Promise.allSettled(this.sourceTails.values());
  }
}
