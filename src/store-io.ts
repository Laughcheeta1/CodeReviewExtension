import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { digestBytes, type FileRecord } from "./domain";
import { decodeSnapshot, encodeSnapshot } from "./snapshot";
import {
  storageFileName,
  storedFile,
} from "./storage-format";
import type { InitializationConfiguration } from "./tracking";

const encoder = new TextEncoder();

/** Own atomic metadata and snapshot file operations for PersistentStore. */
export class StoreFileSystem {
  constructor(
    private readonly directoryUri: vscode.Uri,
    private readonly snapshotsUri: vscode.Uri,
    private readonly initializationUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  fileUri(path: string): vscode.Uri {
    return vscode.Uri.joinPath(this.directoryUri, storageFileName(path));
  }

  async writeSnapshot(file: FileRecord, bytes: Uint8Array): Promise<void> {
    if (
      bytes.byteLength !== file.baseline.size ||
      digestBytes(bytes) !== file.baseline.digest
    ) {
      throw new Error("Snapshot bytes do not match the baseline descriptor");
    }
    await vscode.workspace.fs.createDirectory(this.snapshotsUri);
    const target = vscode.Uri.joinPath(this.snapshotsUri, file.baseline.file);
    try {
      const existing = await vscode.workspace.fs.readFile(target);
      decodeSnapshot(
        existing,
        file.baseline.digest,
        file.baseline.size,
        file.baseline.size + 1,
      );
      return;
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }
    const temporary = vscode.Uri.joinPath(
      this.snapshotsUri,
      `${file.baseline.file}.tmp-${randomUUID()}`,
    );
    try {
      await vscode.workspace.fs.writeFile(temporary, encodeSnapshot(bytes));
      const snapshot = await vscode.workspace.fs.readFile(temporary);
      decodeSnapshot(
        snapshot,
        file.baseline.digest,
        file.baseline.size,
        file.baseline.size + 1,
      );
      await vscode.workspace.fs.rename(temporary, target, {
        overwrite: false,
      });
    } finally {
      await this.deleteTemporary(temporary);
    }
  }

  async writeJson(path: string, file: FileRecord): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.directoryUri);
    const temporary = vscode.Uri.joinPath(
      this.directoryUri,
      `.${storageFileName(path)}.tmp-${randomUUID()}`,
    );
    try {
      const contents = `${JSON.stringify(storedFile(path, file), null, 2)}\n`;
      await vscode.workspace.fs.writeFile(temporary, encoder.encode(contents));
      await vscode.workspace.fs.rename(temporary, this.fileUri(path), {
        overwrite: true,
      });
    } finally {
      await this.deleteTemporary(temporary);
    }
  }

  async writeInitialization(
    configuration: InitializationConfiguration,
  ): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.directoryUri);
    const temporary = vscode.Uri.joinPath(
      this.directoryUri,
      `.initialization.json.tmp-${randomUUID()}`,
    );
    try {
      const contents = `${JSON.stringify(configuration, null, 2)}\n`;
      await vscode.workspace.fs.writeFile(temporary, encoder.encode(contents));
      await vscode.workspace.fs.rename(temporary, this.initializationUri, {
        overwrite: true,
      });
    } finally {
      await this.deleteTemporary(temporary);
    }
  }

  async deleteSnapshot(name: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(
        vscode.Uri.joinPath(this.snapshotsUri, name),
        { useTrash: false },
      );
    } catch (error) {
      if (!isFileNotFound(error)) {
        this.log.warn(`Unable to remove snapshot ${name}: ${String(error)}`);
      }
    }
  }

  async deleteTemporary(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: false });
    } catch (error) {
      if (!isFileNotFound(error)) {
        this.log.warn(
          `Unable to remove temporary file ${uri.path}: ${String(error)}`,
        );
      }
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError && error.code === "FileNotFound"
  );
}
