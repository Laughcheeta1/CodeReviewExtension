import * as vscode from "vscode";
import { isFileNotFound } from "./errors";
import { decodeSnapshot } from "./snapshot";
import {
  parseStoredFile,
  storageFileName,
} from "./storage-format";
import { parseInitializationConfiguration } from "./tracking";
import type { StoreFileSystem } from "./store-io";

const decoder = new TextDecoder("utf-8", { fatal: true });
const INITIALIZATION_FILE = "initialization.json";

export interface MigrationDeps {
  readonly directoryUri: vscode.Uri;
  readonly initializationUri: vscode.Uri;
  readonly legacyDirectoryUri: vscode.Uri;
  readonly legacySnapshotsUri: vscode.Uri;
  readonly fileSystem: StoreFileSystem;
  readonly log: vscode.LogOutputChannel;
}

export async function maybeMigrateLegacy(deps: MigrationDeps): Promise<void> {
  const { directoryUri, fileSystem, legacyDirectoryUri, legacySnapshotsUri, log } = deps;
  try {
    const entries = await vscode.workspace.fs.readDirectory(directoryUri);
    const hasData = entries.some(([name, type]) => {
      if (name === INITIALIZATION_FILE) {
        return true;
      }
      if (
        (type & vscode.FileType.File) !== 0 &&
        name.endsWith(".json") &&
        !name.includes(".tmp-")
      ) {
        return true;
      }
      return false;
    });
    if (hasData) {
      return;
    }
  } catch (error) {
    if (!isFileNotFound(error)) {
      log.warn(
        `Unable to inspect extension storage before migration: ${String(error)}`,
      );
      return;
    }
  }

  let legacyEntries: readonly [string, vscode.FileType][];
  try {
    legacyEntries = await vscode.workspace.fs.readDirectory(legacyDirectoryUri);
  } catch (error) {
    if (isFileNotFound(error)) {
      return;
    }
    log.warn(`Unable to inspect legacy review storage: ${String(error)}`);
    return;
  }

  const legacyInitUri = vscode.Uri.joinPath(
    legacyDirectoryUri,
    INITIALIZATION_FILE,
  );
  let migratedInit = false;
  try {
    const bytes = await vscode.workspace.fs.readFile(legacyInitUri);
    const configuration = parseInitializationConfiguration(
      JSON.parse(decoder.decode(bytes)),
    );
    if (configuration !== undefined) {
      await fileSystem.writeInitialization(configuration);
      log.info(
        `Migrated legacy initialization from ${legacyDirectoryUri.fsPath}`,
      );
      migratedInit = true;
    }
  } catch (error) {
    if (!isFileNotFound(error)) {
      log.warn(`Unable to migrate legacy initialization: ${String(error)}`);
    }
  }

  let migrated = 0;
  for (const [name, type] of legacyEntries) {
    if (name === INITIALIZATION_FILE) {
      continue;
    }
    if (
      (type & vscode.FileType.File) === 0 ||
      !name.endsWith(".json") ||
      name.includes(".tmp-")
    ) {
      continue;
    }
    const legacyFileUri = vscode.Uri.joinPath(legacyDirectoryUri, name);
    try {
      const bytes = await vscode.workspace.fs.readFile(legacyFileUri);
      const parsed = parseStoredFile(JSON.parse(decoder.decode(bytes)));
      if (parsed === undefined || storageFileName(parsed.path) !== name) {
        continue;
      }
      try {
        await vscode.workspace.fs.stat(fileSystem.fileUri(parsed.path));
        continue;
      } catch (statError) {
        if (!isFileNotFound(statError)) {
          throw statError;
        }
      }
      const snapshotName = parsed.file.baseline.file;
      if (snapshotName) {
        const legacySnapshotUri = vscode.Uri.joinPath(
          legacySnapshotsUri,
          snapshotName,
        );
        try {
          const compressed = await vscode.workspace.fs.readFile(
            legacySnapshotUri,
          );
          const raw = decodeSnapshot(
            compressed,
            parsed.file.baseline.digest,
            parsed.file.baseline.size,
            parsed.file.baseline.size + 1,
          );
          await fileSystem.writeSnapshot(parsed.file, raw);
        } catch (error) {
          if (isFileNotFound(error)) {
            continue;
          }
          log.warn(
            `Unable to migrate snapshot ${snapshotName}: ${String(error)}`,
          );
          continue;
        }
      }
      await fileSystem.writeJson(parsed.path, parsed.file);
      migrated += 1;
    } catch (error) {
      log.warn(
        `Unable to migrate legacy metadata ${name}: ${String(error)}`,
      );
    }
  }
  if (migrated > 0) {
    log.info(
      `Migrated ${migrated} legacy review files from ${legacyDirectoryUri.fsPath}`,
    );
  } else if (migratedInit) {
    // Initialization already migrated; no files needed.
  }
}
