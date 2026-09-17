/* eslint-disable */
import assert from "node:assert/strict";
import Module from "node:module";
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
        const err = e as NodeJS.ErrnoException & { message?: string };
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
      return { type: s.isDirectory() ? FileType.Directory : FileType.File, ctime: 0, mtime: 0, size: s.size };
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") throw new FileSystemError(err.message, "FileNotFound");
      throw e;
    }
  },
};
function asRelativePath(uri: FakeUri) {
  const folder = fakeWorkspaceFolders.find((f) => uri.fsPath.startsWith(f.uri.fsPath + "/") || uri.fsPath === f.uri.fsPath);
  if (!folder) return uri.fsPath;
  const rel = relative(folder.uri.fsPath, uri.fsPath);
  return rel.split("\\").join("/");
}
function getWorkspaceFolder(uri: FakeUri) {
  return fakeWorkspaceFolders.find((f) => uri.fsPath === f.uri.fsPath || uri.fsPath.startsWith(f.uri.fsPath + "/"));
}

let warnMessages: string[] = [];
const fakeLog = {
  info() {},
  warn(msg: string) {
    warnMessages.push(String(msg));
  },
  error() {},
  trace() {},
  debug() {},
} as unknown as import("vscode").LogOutputChannel;

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
      },
      window: { createOutputChannel() { return fakeLog; } },
      EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
        dispose() {}
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

let ReviewService: typeof import("../src/review-service.ts").ReviewService;
let storeMod: typeof import("../src/store.ts");

before(async () => {
  ReviewService = (require("../src/review-service.ts") as typeof import("../src/review-service.ts")).ReviewService;
  storeMod = require("../src/store.ts") as typeof import("../src/store.ts");
});

test("ReviewService.initialize does not throw when storageUri is undefined", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ws-"));
  try {
    fakeWorkspaceFolders = [
      { uri: FakeUri.file(workspace) as unknown as FakeUri, name: "ws", index: 0 } as unknown as typeof fakeWorkspaceFolders[number],
    ];
    warnMessages = [];
    const git = {} as unknown as import("../src/git.ts").GitService;
    const ignoreRules = { ignoredPaths: async () => new Set<string>() } as unknown as import("../src/git-ignore.ts").GitIgnoreService;
    const service = new ReviewService(fakeLog as unknown as import("vscode").LogOutputChannel, git, ignoreRules, undefined);
    await assert.doesNotReject(() => service.initialize());
    assert.ok(warnMessages.some((m) => m.includes("storage is unavailable") || m.includes("Workspace storage is unavailable")));
    assert.equal(service["stores"].size, 0, "no stores should be created without storage");
    service.dispose();
  } finally {
    await rm(workspace, { recursive: true, force: true });
    fakeWorkspaceFolders = [];
  }
});

test("ReviewService.initialize isolates per-folder failures and still registers other folders", async () => {
  const storageBase = await mkdtemp(join(tmpdir(), "storage-"));
  const workspaceA = await mkdtemp(join(tmpdir(), "wsA-"));
  const workspaceB = await mkdtemp(join(tmpdir(), "wsB-"));
  try {
    fakeWorkspaceFolders = [
      { uri: FakeUri.file(workspaceA) as unknown as FakeUri, name: "A", index: 0 } as unknown as typeof fakeWorkspaceFolders[number],
      { uri: FakeUri.file(workspaceB) as unknown as FakeUri, name: "B", index: 1 } as unknown as typeof fakeWorkspaceFolders[number],
    ];
    warnMessages = [];
    const storageUri = FakeUri.file(storageBase) as unknown as import("vscode").Uri;
    const git = {} as unknown as import("../src/git.ts").GitService;
    const ignoreRules = { ignoredPaths: async () => new Set<string>() } as unknown as import("../src/git-ignore.ts").GitIgnoreService;

    // Make the first folder's store initialization throw
    const originalInit = storeMod.PersistentStore.prototype.initialize;
    let callIndex = 0;
    (storeMod.PersistentStore.prototype as any).initialize = async function (this: unknown) {
      callIndex += 1;
      if (callIndex === 1) throw new Error("injected init failure for A");
      return originalInit.call(this);
    };

    const service = new ReviewService(fakeLog as unknown as import("vscode").LogOutputChannel, git, ignoreRules, storageUri);
    await assert.doesNotReject(() => service.initialize());
    assert.equal(service["stores"].size, 1, "failing folder must be isolated, other folder still initializes");
    assert.ok(warnMessages.some((m) => m.includes("injected init failure") || m.includes("Review tracking is unavailable")));
    service.dispose();
    storeMod.PersistentStore.prototype.initialize = originalInit;
  } finally {
    storeMod.PersistentStore.prototype.initialize = storeMod.PersistentStore.prototype.initialize;
    // Ensure restore if test threw before restore
    try {
      // Re-require to get original if patched
      delete require.cache[require.resolve("../src/store.ts")];
    } catch {}
    await rm(storageBase, { recursive: true, force: true });
    await rm(workspaceA, { recursive: true, force: true });
    await rm(workspaceB, { recursive: true, force: true });
    fakeWorkspaceFolders = [];
  }
});
