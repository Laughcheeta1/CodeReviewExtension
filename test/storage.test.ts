/* eslint-disable */
import assert from "node:assert/strict";
import Module from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import test, { before } from "node:test";

class FileSystemError extends Error {
  code: string;
  constructor(message = "", code = "Unknown") {
    super(message);
    this.code = code;
  }
}

class FakeUri {
  scheme = "file";
  authority = "";
  path: string;
  fsPath: string;
  constructor(fsPath: string) {
    this.fsPath = fsPath;
    this.path = fsPath;
  }
  toString() {
    return `file://${this.fsPath}`;
  }
  static file(p: string) {
    return new FakeUri(p);
  }
  static joinPath(base: FakeUri, ...parts: string[]) {
    return new FakeUri(join(base.fsPath, ...parts));
  }
  static parse(value: string) {
    const p = value.startsWith("file://") ? value.slice(7) : value;
    return new FakeUri(p);
  }
}

const FileType = { File: 1, Directory: 2, SymbolicLink: 64 } as const;

let fakeWorkspaceFolders: { uri: FakeUri; name: string; index: number }[] = [];

const fakeWorkspaceFs = {
  async createDirectory(uri: FakeUri) {
    await mkdir(uri.fsPath, { recursive: true });
  },
  async writeFile(uri: FakeUri, content: Uint8Array) {
    await mkdir(dirname(uri.fsPath), { recursive: true });
    await writeFile(uri.fsPath, content);
  },
  async readFile(uri: FakeUri) {
    try {
      const data = await readFile(uri.fsPath);
      return new Uint8Array(data);
    } catch (error: unknown) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") throw new FileSystemError(e.message, "FileNotFound");
      throw error;
    }
  },
  async readDirectory(uri: FakeUri) {
    try {
      const entries = await (await import("node:fs/promises")).readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((e) => [e.name, e.isDirectory() ? FileType.Directory : e.isFile() ? FileType.File : 0] as const);
    } catch (error: unknown) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") throw new FileSystemError(e.message, "FileNotFound");
      throw error;
    }
  },
  async delete(uri: FakeUri, options?: { recursive?: boolean; useTrash?: boolean }) {
    try {
      if (options?.recursive) {
        await rm(uri.fsPath, { recursive: true, force: true });
      } else {
        await (await import("node:fs/promises")).unlink(uri.fsPath);
      }
    } catch (error: unknown) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") throw new FileSystemError(e.message, "FileNotFound");
      throw error;
    }
  },
  async rename(source: FakeUri, target: FakeUri, options?: { overwrite?: boolean }) {
    if (!options?.overwrite) {
      try {
        await stat(target.fsPath);
        throw new Error("target exists");
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          if (e instanceof FileSystemError) throw e;
          if ((e as Error).message === "target exists") throw e;
        }
      }
    }
    await mkdir(dirname(target.fsPath), { recursive: true });
    const { rename } = await import("node:fs/promises");
    await rename(source.fsPath, target.fsPath);
  },
  async stat(uri: FakeUri) {
    try {
      const s = await stat(uri.fsPath);
      return { type: s.isDirectory() ? FileType.Directory : FileType.File, ctime: 0, mtime: 0, size: s.size };
    } catch (error: unknown) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") throw new FileSystemError(e.message, "FileNotFound");
      throw error;
    }
  },
};

function asRelativePath(uri: FakeUri, strict?: boolean) {
  const folder = fakeWorkspaceFolders.find((f) => uri.fsPath.startsWith(f.uri.fsPath + "/") || uri.fsPath === f.uri.fsPath);
  if (!folder) return strict ? uri.fsPath : uri.fsPath;
  const rel = relative(folder.uri.fsPath, uri.fsPath);
  return rel.split("\\").join("/");
}

function getWorkspaceFolder(uri: FakeUri) {
  return fakeWorkspaceFolders.find((f) => uri.fsPath === f.uri.fsPath || uri.fsPath.startsWith(f.uri.fsPath + "/"));
}

const fakeLog = { info() {}, warn() {}, error() {}, trace() {}, debug() {} } as unknown as import("vscode").LogOutputChannel;

const moduleLoader = Module as unknown as {
  _load(request: string, parent?: unknown, isMain?: unknown): unknown;
};
const originalLoad = moduleLoader._load.bind(moduleLoader);
moduleLoader._load = function (request: string, parent?: unknown, isMain?: unknown): unknown {
  if (request === "vscode") {
    return {
      FileSystemError,
      FileType,
      Uri: FakeUri,
      workspace: {
        fs: fakeWorkspaceFs,
        get workspaceFolders() {
          return fakeWorkspaceFolders as unknown as import("vscode").WorkspaceFolder[];
        },
        asRelativePath: asRelativePath as unknown as typeof import("vscode").workspace.asRelativePath,
        getWorkspaceFolder: getWorkspaceFolder as unknown as typeof import("vscode").workspace.getWorkspaceFolder,
      },
      window: { createOutputChannel() { return fakeLog; } },
      EventEmitter: class {},
    };
  }
  return originalLoad(request, parent, isMain);
};

// Import after stubbing
let naming: typeof import("../src/storage-format/naming.ts");
let storeMod: typeof import("../src/store.ts");
let storageFormat: typeof import("../src/storage-format.ts");
before(async () => {
  naming = require("../src/storage-format/naming.ts") as typeof import("../src/storage-format/naming.ts");
  storeMod = require("../src/store.ts") as typeof import("../src/store.ts");
  storageFormat = require("../src/storage-format.ts") as typeof import("../src/storage-format.ts");
});

test("folderHash is deterministic and collision free per folder uri", () => {
  const a = naming.folderHash("file:///tmp/folderA");
  const b = naming.folderHash("file:///tmp/folderB");
  const a2 = naming.folderHash("file:///tmp/folderA");
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.equal(a, a2);
});

test("store directories isolate multiple workspace folders", async () => {
  const storageBase = await mkdtemp(join(tmpdir(), "code-review-storage-base-"));
  const workspaceA = await mkdtemp(join(tmpdir(), "code-review-workspace-A-"));
  const workspaceB = await mkdtemp(join(tmpdir(), "code-review-workspace-B-"));
  try {
    const storageUri = FakeUri.file(storageBase) as unknown as import("vscode").Uri;
    const folderA = { uri: FakeUri.file(workspaceA) as unknown as import("vscode").Uri, name: "A", index: 0 } as unknown as import("vscode").WorkspaceFolder;
    const folderB = { uri: FakeUri.file(workspaceB) as unknown as import("vscode").Uri, name: "B", index: 1 } as unknown as import("vscode").WorkspaceFolder;
    fakeWorkspaceFolders = [folderA as unknown as typeof fakeWorkspaceFolders[number], folderB as unknown as typeof fakeWorkspaceFolders[number]];

    const storeA = new storeMod.PersistentStore(folderA, fakeLog as unknown as import("vscode").LogOutputChannel, storageUri);
    const storeB = new storeMod.PersistentStore(folderB, fakeLog as unknown as import("vscode").LogOutputChannel, storageUri);

    const dirA = (storeA.storeDirectoryUri as unknown as FakeUri).fsPath;
    const dirB = (storeB.storeDirectoryUri as unknown as FakeUri).fsPath;
    assert.notEqual(dirA, dirB);
    assert.ok(dirA.startsWith(storageBase));
    assert.ok(dirB.startsWith(storageBase));

    // Same relative path in different workspaces must not share file uri
    const fileUriA = (storeA as unknown as { fileSystem: { fileUri(p: string): FakeUri } })["fileSystem"].fileUri("src/app.ts");
    const fileUriB = (storeB as unknown as { fileSystem: { fileUri(p: string): FakeUri } })["fileSystem"].fileUri("src/app.ts");
    assert.notEqual((fileUriA as unknown as FakeUri).fsPath, (fileUriB as unknown as FakeUri).fsPath);
  } finally {
    await rm(storageBase, { recursive: true, force: true });
    await rm(workspaceA, { recursive: true, force: true });
    await rm(workspaceB, { recursive: true, force: true });
    fakeWorkspaceFolders = [];
  }
});

test("PersistentStore writes to extension storage, not legacy repo path", async () => {
  const storageBase = await mkdtemp(join(tmpdir(), "code-review-storage-"));
  const workspace = await mkdtemp(join(tmpdir(), "code-review-workspace-"));
  try {
    const storageUri = FakeUri.file(storageBase) as unknown as import("vscode").Uri;
    const folder = { uri: FakeUri.file(workspace) as unknown as import("vscode").Uri, name: "ws", index: 0 } as unknown as import("vscode").WorkspaceFolder;
    fakeWorkspaceFolders = [folder as unknown as typeof fakeWorkspaceFolders[number]];
    const store = new storeMod.PersistentStore(folder, fakeLog as unknown as import("vscode").LogOutputChannel, storageUri);
    await store.initialize();
    await store.enableTracking([{ kind: "folder", path: "" }]);

    const initializationInStorage = join((store.storeDirectoryUri as unknown as FakeUri).fsPath, "initialization.json");
    const initializationInLegacy = join(workspace, ".vscode", "code-review-tracker", "initialization.json");
    const statStorage = await stat(initializationInStorage);
    assert.ok(statStorage.isFile());
    let legacyExists = true;
    try {
      await stat(initializationInLegacy);
    } catch {
      legacyExists = false;
    }
    assert.equal(legacyExists, false, "legacy repo path should not be written");

    // Commit a file and verify metadata/snapshot under extension storage
    const { createRecord } = await import("../src/source-io.ts");
    const git = { diff() { return Promise.resolve([]); } } as unknown as import("../src/git.ts").GitService;
    const bytes = new TextEncoder().encode("hello\n");
    const source = { modifiedAt: Date.now(), size: bytes.byteLength };
    const record = await createRecord(git, "src/app.ts", bytes, bytes, source);
    await store.commit("src/app.ts", record, bytes);

    const hash = naming.pathHash("src/app.ts");
    const metaPath = join((store.storeDirectoryUri as unknown as FakeUri).fsPath, `${hash}.json`);
    const snapshotPath = join((store.storeDirectoryUri as unknown as FakeUri).fsPath, "snapshots", `${hash}.${record.baseline.digest}.gz`);
    assert.ok((await stat(metaPath)).isFile());
    assert.ok((await stat(snapshotPath)).isFile());

    const legacyMeta = join(workspace, ".vscode", "code-review-tracker", `${hash}.json`);
    let legacyMetaExists = true;
    try {
      await stat(legacyMeta);
    } catch {
      legacyMetaExists = false;
    }
    assert.equal(legacyMetaExists, false);

    // Reset should remove extension storage but leave repo untouched
    await store.reset();
    let storageExists = true;
    try {
      await stat((store.storeDirectoryUri as unknown as FakeUri).fsPath);
    } catch {
      storageExists = false;
    }
    // reset preserves initialization.json, so directory still exists with init file
    assert.equal(storageExists, true);
    const afterResetEntries = await fakeWorkspaceFs.readDirectory(store.storeDirectoryUri as unknown as FakeUri) as [string, number][];
    // Only initialization.json should remain
    const names = afterResetEntries.map(([n]) => n);
    assert.ok(names.includes("initialization.json"));
    assert.equal(names.filter((n) => n.endsWith(".json") && n !== "initialization.json").length, 0);
  } finally {
    await rm(storageBase, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    fakeWorkspaceFolders = [];
  }
});

test("one-time migration copies valid legacy state and leaves legacy untouched", async () => {
  const storageBase = await mkdtemp(join(tmpdir(), "code-review-storage-migrate-"));
  const workspace = await mkdtemp(join(tmpdir(), "code-review-workspace-migrate-"));
  try {
    const legacyDir = join(workspace, ".vscode", "code-review-tracker");
    const legacySnapshots = join(legacyDir, "snapshots");
    await mkdir(legacySnapshots, { recursive: true });

    // Create legacy initialization
    await writeFile(join(legacyDir, "initialization.json"), JSON.stringify({ schemaVersion: 1, state: "initialized", targets: [{ kind: "folder", path: "" }] }, null, 2));

    // Create legacy metadata + snapshot via real file construction
    const storageUri = FakeUri.file(storageBase) as unknown as import("vscode").Uri;
    const folder = { uri: FakeUri.file(workspace) as unknown as import("vscode").Uri, name: "ws", index: 0 } as unknown as import("vscode").WorkspaceFolder;
    fakeWorkspaceFolders = [folder as unknown as typeof fakeWorkspaceFolders[number]];

    // Use a temporary store to generate a valid record in legacy location directly
    const { createRecord } = await import("../src/source-io.ts");
    const git = { diff() { return Promise.resolve([]); } } as unknown as import("../src/git.ts").GitService;
    const bytes = new TextEncoder().encode("legacy\n");
    const source = { modifiedAt: Date.now(), size: bytes.byteLength };
    const record = await createRecord(git, "src/legacy.ts", bytes, bytes, source);
    const hash = naming.pathHash("src/legacy.ts");
    const { encodeSnapshot } = await import("../src/snapshot.ts");
    await writeFile(join(legacyDir, `${hash}.json`), JSON.stringify({ schemaVersion: 4, path: "src/legacy.ts", file: record }, null, 2));
    await writeFile(join(legacySnapshots, `${hash}.${record.baseline.digest}.gz`), encodeSnapshot(bytes));

    const store = new storeMod.PersistentStore(folder, fakeLog as unknown as import("vscode").LogOutputChannel, storageUri);
    await store.initialize();

    // After migration, extension storage should have the legacy file
    const migratedMeta = join((store.storeDirectoryUri as unknown as FakeUri).fsPath, `${hash}.json`);
    const migratedSnap = join((store.storeDirectoryUri as unknown as FakeUri).fsPath, "snapshots", `${hash}.${record.baseline.digest}.gz`);
    assert.ok((await stat(migratedMeta)).isFile());
    assert.ok((await stat(migratedSnap)).isFile());

    // Legacy should remain untouched
    assert.ok((await stat(join(legacyDir, `${hash}.json`))).isFile());
    assert.ok((await stat(join(legacySnapshots, `${hash}.${record.baseline.digest}.gz`))).isFile());

    // Second initialization should not duplicate or overwrite
    const store2 = new storeMod.PersistentStore(folder, fakeLog as unknown as import("vscode").LogOutputChannel, storageUri);
    await store2.initialize();
    assert.ok((await stat(migratedMeta)).isFile());
  } finally {
    await rm(storageBase, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    fakeWorkspaceFolders = [];
  }
});
