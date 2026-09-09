/* eslint-disable */
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import test, { before } from "node:test";
// RevExt: 1
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
// RevExt: 2
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
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") throw new FileSystemError(err.message, "FileNotFound");
      throw e;
    }
  },
  async readDirectory(uri: FakeUri) {
    try {
      const entries = await (await import("node:fs/promises")).readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((e) => [e.name, e.isDirectory() ? FileType.Directory : e.isFile() ? FileType.File : 0] as const);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") throw new FileSystemError(err.message, "FileNotFound");
      throw e;
    }
  },
  async delete(uri: FakeUri, options?: { recursive?: boolean; useTrash?: boolean }) {
    try {
      if (options?.recursive) await rm(uri.fsPath, { recursive: true, force: true });
      else await (await import("node:fs/promises")).unlink(uri.fsPath);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") throw new FileSystemError(err.message, "FileNotFound");
      throw e;
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
          if ((e as Error).message === "target exists") throw e;
          if (e instanceof FileSystemError) throw e;
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
      return { type: s.isDirectory() ? FileType.Directory : FileType.File, ctime: s.mtimeMs, mtime: s.mtimeMs, size: s.size };
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") throw new FileSystemError(err.message, "FileNotFound");
      throw e;
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
// RevExt: 3
const fakeLog = { info() {}, warn() {}, error() {}, trace() {}, debug() {} } as unknown as import("vscode").LogOutputChannel;
// RevExt: 4
const moduleLoader = Module as unknown as { _load(request: string, parent?: unknown, isMain?: unknown): unknown };
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
        getConfiguration: () => ({
          get: (_key: string, def: unknown) => def,
        }),
      },
      window: { createOutputChannel() { return fakeLog; } },
      EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
        dispose() {}
      },
      ProgressLocation: { Notification: 15 },
      TabInputText: class {},
      TabInputTextDiff: class {},
    };  // RevExt: 34
  }
  return originalLoad(request, parent, isMain);
};
// RevExt: 5
let initMod: typeof import("../src/review-service/lifecycle/init.ts");
// RevExt: 6
before(async () => {
  initMod = require("../src/review-service/lifecycle/init.ts") as typeof import("../src/review-service/lifecycle/init.ts");
});
// RevExt: 7
test("initializeMissingSource syncs tracked set before eligibility check (unit)", async () => {
  // Regression: per-file tracked workspaces left new files untracked because
  // includeTrackingTarget updated initialization.json but not the in-memory
  // EligibilityTracker set. isTrackableUri then stayed false and metadata was
  // never created, so open/save/command/diff/folder fallbacks all appeared to
  // work while the file stayed invisible.
  const folder = {
    uri: FakeUri.file("/ws") as unknown as import("vscode").Uri,
    name: "ws",
    index: 0,
  } as unknown as import("vscode").WorkspaceFolder;
  const newFileUri = FakeUri.file("/ws/newfile.txt") as unknown as import("vscode").Uri;
  const tracked = new Set<string>(["existing.txt"]);
  let trackPathCalls: string[] = [];
  let recomputeCalls = 0;
// RevExt: 8
  const fakeStore = {
    initializationState: "initialized",
    includeTrackingTarget: async () => true,
  };
// RevExt: 9
  const deps = {
    log: fakeLog as unknown as import("vscode").LogOutputChannel,
    relativePath: () => "newfile.txt",
    storeFor: () => fakeStore as unknown as import("../src/store.ts").PersistentStore,
    storeForFolder: () => fakeStore as unknown as import("../src/store.ts").PersistentStore,
    dirtyDocument: () => undefined,
    withSource: async (_uri: unknown, op: () => Promise<unknown>) => op(),
    recompute: async () => {
      recomputeCalls += 1;
      return true;  // RevExt: 36
    },
    ensureIncludes: async () => true,
    isTrackableUri: () => tracked.has("newfile.txt"),
    trackPath: (_folder: unknown, path: string) => {
      trackPathCalls.push(path);
      tracked.add(path);
    },
    notifyChanged: () => {},
  } as unknown as Parameters<typeof initMod.initializeMissingSource>[0];
// RevExt: 10
  fakeWorkspaceFolders = [folder as unknown as typeof fakeWorkspaceFolders[number]];
  const result = await initMod.initializeMissingSource(deps, newFileUri as unknown as import("vscode").Uri);
// RevExt: 11
  assert.equal(result, true, "new file must be initialized");
  assert.deepEqual(trackPathCalls, ["newfile.txt"], "tracked set must be synced after include");
  assert.equal(recomputeCalls, 1, "recompute must be reached after trackPath");
  assert.equal(tracked.has("newfile.txt"), true);
  fakeWorkspaceFolders = [];
});
// RevExt: 12
test("initializeMissingSource still respects dirty documents", async () => {
  const folder = {
    uri: FakeUri.file("/ws") as unknown as import("vscode").Uri,
    name: "ws",
    index: 0,
  } as unknown as import("vscode").WorkspaceFolder;
  const newFileUri = FakeUri.file("/ws/newfile.txt") as unknown as import("vscode").Uri;
  const fakeStore = {
    initializationState: "initialized",
    includeTrackingTarget: async () => {
      assert.fail("includeTrackingTarget must not be called for dirty document");
      return false;
    },
  };
  let recomputeCalls = 0;
  const deps = {
    log: fakeLog as unknown as import("vscode").LogOutputChannel,
    relativePath: () => "newfile.txt",
    storeFor: () => fakeStore as unknown as import("../src/store.ts").PersistentStore,
    storeForFolder: () => fakeStore as unknown as import("../src/store.ts").PersistentStore,
    dirtyDocument: () => ({ uri: newFileUri } as unknown as import("vscode").TextDocument),
    withSource: async () => {
      recomputeCalls += 1;
      return true;  // RevExt: 37
    },
    recompute: async () => {
      recomputeCalls += 1;
      return true;  // RevExt: 38
    },
    ensureIncludes: async () => true,
    isTrackableUri: () => false,
    trackPath: () => assert.fail("trackPath must not be called for dirty document"),
    notifyChanged: () => {},
  } as unknown as Parameters<typeof initMod.initializeMissingSource>[0];
// RevExt: 13
  fakeWorkspaceFolders = [folder as unknown as typeof fakeWorkspaceFolders[number]];
  const result = await initMod.initializeMissingSource(deps, newFileUri as unknown as import("vscode").Uri);
  assert.equal(result, false);
  assert.equal(recomputeCalls, 0);
  fakeWorkspaceFolders = [];
});
// RevExt: 14
test("initializeMissingSource end-to-end with real store and snapshot (integration)", async () => {
  // Real-world inner workings: use the actual PersistentStore, real
  // filesystem and real snapshot codec, but keep the eligibility Set
  // deterministic so the test isolates the exact regression:
  // includeTrackingTarget -> trackPath -> isTrackableUri -> recompute.
  // The bug was that trackPath was never called, so isTrackableUri stayed
  // false and recompute was unreachable even though the file was eligible.
  const storageBase = await mkdtemp(join(tmpdir(), "storage-"));
  const workspace = await mkdtemp(join(tmpdir(), "ws-"));
  try {
    fakeWorkspaceFolders = [
      { uri: FakeUri.file(workspace) as unknown as FakeUri, name: "ws", index: 0 } as unknown as typeof fakeWorkspaceFolders[number],
    ];
    const folder = fakeWorkspaceFolders[0] as unknown as import("vscode").WorkspaceFolder;
    const storageUri = FakeUri.file(storageBase) as unknown as import("vscode").Uri;
// RevExt: 24
    const { PersistentStore } = require("../src/store.ts") as typeof import("../src/store.ts");
    const { SourceGate } = require("../src/review-service/gate.ts") as typeof import("../src/review-service/gate.ts");
    const { GitService } = require("../src/git.ts") as typeof import("../src/git.ts");
// RevExt: 25
    const store = new PersistentStore(folder, fakeLog as unknown as import("vscode").LogOutputChannel, storageUri);
    await store.initialize();
    await store.enableTracking([{ kind: "folder", path: "" }]);
// RevExt: 26
    // Eligibility is modelled as a real Set that mirrors what
    // EligibilityTracker does: discovered files are known, but the tracked
    // set is stale until trackPath is called. Using a plain Set keeps the
    // test deterministic while still exercising the real store + snapshot.
    const tracked = new Set<string>(["existing.txt"]);
    const gate = new SourceGate();
    const git = new GitService();
// RevExt: 27
    const newFilePath = join(workspace, "newfile.txt");
    await mkdir(dirname(newFilePath), { recursive: true });
    await writeFile(newFilePath, "hello\nnew file\n");
// RevExt: 28
    const { recomputeSource } = require("../src/review-service/recompute.ts") as typeof import(
      "../src/review-service/recompute.ts"
    );  // RevExt: 40
// RevExt: 29
    // isEligibleSource must be real (ignore-rule aware) to prove the file
    // would have been accepted in a real workspace. For this integration
    // case the file is not ignored, so we can return true via a trivial
    // check that still exercises the guard.
    const isEligibleSource = async (candidate: import("vscode").Uri) => {
      const rel = relative(workspace, (candidate as unknown as FakeUri).fsPath).split("\\").join("/");
      // Mirrors EligibilityTracker.isEligibleSource without needing a full
      // GitIgnoreService stack in this isolated test.
      if (rel.startsWith(".git/") || rel.startsWith("node_modules")) return false;
      return true;  // RevExt: 39
    };  // RevExt: 35
// RevExt: 30
    const recompute = (uri: import("vscode").Uri, force: boolean, createMissing = false) =>
      recomputeSource(
        {
          git,
          log: fakeLog as unknown as import("vscode").LogOutputChannel,
          isEligibleSource,
          relativePath: (candidate) => relative(workspace, (candidate as unknown as FakeUri).fsPath).split("\\").join("/"),
          storeFor: () => store as unknown as import("../src/store.ts").PersistentStore,
          maxSize: () => 1024 * 1024,
          ignoreEmptyLineDeletions: () => false,
          promoteFile: async () => {},
        },
        uri,
        force,
        createMissing,
      );
// RevExt: 31
    const deps: Parameters<typeof initMod.initializeMissingSource>[0] = {
      log: fakeLog as unknown as import("vscode").LogOutputChannel,
      relativePath: (uri: import("vscode").Uri) => relative(workspace, (uri as unknown as FakeUri).fsPath).split("\\").join("/"),
      storeFor: () => store as unknown as import("../src/store.ts").PersistentStore,
      storeForFolder: () => store as unknown as import("../src/store.ts").PersistentStore,
      dirtyDocument: () => undefined,
      withSource: (uri: import("vscode").Uri, op: () => Promise<unknown>) => gate.withSource(uri, op),
      recompute: (uri: import("vscode").Uri, force: boolean, createMissing?: boolean) =>
        recompute(uri, force, createMissing as boolean),
      ensureIncludes: async (_fld: unknown, _path: string) => true,
      isTrackableUri: (uri: import("vscode").Uri) => tracked.has(relative(workspace, (uri as unknown as FakeUri).fsPath).split("\\").join("/")),
      trackPath: (_fld: unknown, path: string) => {
        tracked.add(path);
      },
      notifyChanged: () => {},
    } as unknown as Parameters<typeof initMod.initializeMissingSource>[0];
// RevExt: 32
    const uri = FakeUri.file(newFilePath) as unknown as import("vscode").Uri;
    const result = await initMod.initializeMissingSource(deps, uri);
    assert.equal(result, true, "real store must create metadata for new file");
// RevExt: 33
    // Verify persisted artifacts exactly as integration suite does: JSON + snapshot, correct digests
    const hash = (await import("../src/storage-format/naming.ts")).pathHash("newfile.txt");
    const metaPath = join(storageBase, (await import("../src/storage-format/naming.ts")).folderHash(folder.uri.toString()), `${hash}.json`);
    const metaStat = await stat(metaPath);
    assert.ok(metaStat.isFile(), "metadata JSON must exist in extension storage");
    const meta = JSON.parse(await readFile(metaPath, "utf-8"));
    assert.equal(meta.path, "newfile.txt");
    assert.equal(meta.schemaVersion, 4);
    assert.match(meta.file.current.digest, /^[0-9a-f]{64}$/);
    const snapshotPath = join(
      storageBase,
      (await import("../src/storage-format/naming.ts")).folderHash(folder.uri.toString()),
      "snapshots",
      meta.file.baseline.file,
    );  // RevExt: 41
    const snapStat = await stat(snapshotPath);
    assert.ok(snapStat.isFile(), "content-addressed gzip snapshot must exist");
    // Verify tracked set was updated so decorations/sidebar will see the file
    assert.equal(tracked.has("newfile.txt"), true);
  } finally {
    await rm(storageBase, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    fakeWorkspaceFolders = [];
  }
});
