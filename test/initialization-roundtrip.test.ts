/* eslint-disable */
// Initialization round-trip contract: initializing tracking and then closing
// and reopening VS Code must not produce "Invalid v4 per-file review metadata".
//
// The regression covered here is blame-derived `reviewed` lines persisted
// without `lastReviewer`: they pass in-memory checks but fail v4 validation on
// the next startup scan/load. These tests commit pending/reviewed records plus
// a blame-classified record through the real PersistentStore, then simulate a
// restart with a fresh store instance and require every record to reload.
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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
      return { type: s.isDirectory() ? FileType.Directory : FileType.File, ctime: s.mtimeMs, mtime: s.mtimeMs, size: s.size };
    } catch (error: unknown) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") throw new FileSystemError(e.message, "FileNotFound");
      throw error;
    }
  },
};

let warnMessages: string[] = [];
let infoMessages: string[] = [];
const fakeLog = {
  info(msg: string) {
    infoMessages.push(String(msg));
  },
  warn(msg: string) {
    warnMessages.push(String(msg));
  },
  error() {},
  trace() {},
  debug() {},
} as unknown as import("vscode").LogOutputChannel;

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
        asRelativePath: ((uri: FakeUri) => {
          const folder = fakeWorkspaceFolders.find((f) => uri.fsPath.startsWith(f.uri.fsPath + "/") || uri.fsPath === f.uri.fsPath);
          if (!folder) return uri.fsPath;
          const { relative } = require("node:path");
          return relative(folder.uri.fsPath, uri.fsPath).split("\\").join("/");
        }) as unknown as typeof import("vscode").workspace.asRelativePath,
        getWorkspaceFolder: ((uri: FakeUri) => {
          return fakeWorkspaceFolders.find((f) => uri.fsPath === f.uri.fsPath || uri.fsPath.startsWith(f.uri.fsPath + "/"));
        }) as unknown as typeof import("vscode").workspace.getWorkspaceFolder,
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
    };
  }
  return originalLoad(request, parent, isMain);
};

let storeMod: typeof import("../src/store.ts");
let diffMod: typeof import("../src/domain/diff.ts");
let blameMod: typeof import("../src/domain/blame.ts");
let identityMod: typeof import("../src/domain/identity.ts");
let statusMod: typeof import("../src/domain/status.ts");
let recordMod: typeof import("../src/storage-format/record.ts");
let schemaMod: typeof import("../src/storage-format/schema.ts");
let sourceIo: typeof import("../src/source-io.ts");
let naming: typeof import("../src/storage-format/naming.ts");
let snapshotMod: typeof import("../src/snapshot.ts");

before(async () => {
  storeMod = require("../src/store.ts") as typeof import("../src/store.ts");
  diffMod = require("../src/domain/diff.ts") as typeof import("../src/domain/diff.ts");
  blameMod = require("../src/domain/blame.ts") as typeof import("../src/domain/blame.ts");
  identityMod = require("../src/domain/identity.ts") as typeof import("../src/domain/identity.ts");
  statusMod = require("../src/domain/status.ts") as typeof import("../src/domain/status.ts");
  recordMod = require("../src/storage-format/record.ts") as typeof import("../src/storage-format/record.ts");
  schemaMod = require("../src/storage-format/schema.ts") as typeof import("../src/storage-format/schema.ts");
  sourceIo = require("../src/source-io.ts") as typeof import("../src/source-io.ts");
  naming = require("../src/storage-format/naming.ts") as typeof import("../src/storage-format/naming.ts");
  snapshotMod = require("../src/snapshot.ts") as typeof import("../src/snapshot.ts");
});

async function makeFolder() {
  const storageBase = await mkdtemp(join(tmpdir(), "init-roundtrip-storage-"));
  const workspace = await mkdtemp(join(tmpdir(), "init-roundtrip-ws-"));
  const storageUri = FakeUri.file(storageBase) as unknown as import("vscode").Uri;
  const folder = { uri: FakeUri.file(workspace) as unknown as import("vscode").Uri, name: "ws", index: 0 } as unknown as import("vscode").WorkspaceFolder;
  fakeWorkspaceFolders = [folder as unknown as typeof fakeWorkspaceFolders[number]];
  warnMessages = [];
  infoMessages = [];
  return { storageBase, workspace, storageUri, folder };
}

test("initialization persists pending and reviewed records across a simulated restart", async () => {
  // User scenario: initialize the extension (Start Pending for one file, Start
  // Reviewed for another), close VS Code, reopen. Both metadata files must
  // reload without "Invalid v4 per-file review metadata".
  const { storageBase, workspace, storageUri, folder } = await makeFolder();
  try {
    const git = { diff() { return Promise.resolve([]); } } as unknown as import("../src/git.ts").GitService;
    const store = new storeMod.PersistentStore(folder, fakeLog as unknown as import("vscode").LogOutputChannel, storageUri);
    await store.initialize();
    await store.enableTracking([{ kind: "folder", path: "" }]);

    // Start Pending: empty baseline, every current line is added/pending.
    const pendingBytes = new TextEncoder().encode("pending one\npending two\n");
    const pendingSource = { modifiedAt: Date.now(), size: pendingBytes.byteLength };
    const { initialAdditionHunks } = await import("../src/review-service-utils.ts");
    const pendingRecord = await sourceIo.createRecord(git, "pending.txt", new Uint8Array(), pendingBytes, pendingSource, undefined, initialAdditionHunks(pendingBytes));
    await store.commit("pending.txt", pendingRecord, new Uint8Array());

    // Start Reviewed: current bytes are the reviewed baseline.
    const reviewedBytes = new TextEncoder().encode("reviewed one\nreviewed two\n");
    const reviewedSource = { modifiedAt: Date.now(), size: reviewedBytes.byteLength };
    const reviewedRecord = await sourceIo.createRecord(git, "reviewed.txt", reviewedBytes, reviewedBytes, reviewedSource);
    await store.commit("reviewed.txt", reviewedRecord, reviewedBytes);

    // Both artifacts must exist on disk before the restart.
    for (const relativePath of ["pending.txt", "reviewed.txt"]) {
      const hash = naming.pathHash(relativePath);
      assert.ok((await stat(join((store.storeDirectoryUri as unknown as FakeUri).fsPath, `${hash}.json`))).isFile(), `metadata JSON must exist for ${relativePath}`);
    }

    // Simulate closing and reopening VS Code: a fresh store scans the same
    // storage directory. This is the exact step that used to throw
    // "Invalid v4 per-file review metadata".
    warnMessages = [];
    const restarted = new storeMod.PersistentStore(folder, fakeLog as unknown as import("vscode").LogOutputChannel, storageUri);
    await assert.doesNotReject(() => restarted.initialize(), "restart must not throw during initialization scan");
    assert.equal(restarted.initializationState, "initialized");
    assert.deepEqual([...restarted.paths].sort(), ["pending.txt", "reviewed.txt"]);

    const pending = await restarted.load("pending.txt");
    assert.ok(pending, "pending record must exist after restart");
    assert.equal(pending.fileStatus, "pending");

    const reviewed = await restarted.load("reviewed.txt");
    assert.ok(reviewed, "reviewed record must exist after restart");
    assert.equal(reviewed.fileStatus, "reviewed");

    // Snapshots must still decode to the recorded baseline digests.
    for (const [relativePath, file] of [["pending.txt", pending], ["reviewed.txt", reviewed]] as const) {
      const decoded = await restarted.loadBaseline(file!, 1024 * 1024);
      const { digestBytes } = identityMod;
      assert.equal(digestBytes(decoded), file!.baseline.digest, `baseline snapshot for ${relativePath} must match its digest`);
    }

    assert.ok(
      warnMessages.every((message) => !message.includes("Invalid v4") && !message.includes("Ignoring metadata file")),
      `restart must not warn about invalid metadata: ${JSON.stringify(warnMessages)}`,
    );
    assert.ok(infoMessages.some((message) => message.includes("Review store initialized")), "restart must log a store-initialized summary");
  } finally {
    await rm(storageBase, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    fakeWorkspaceFolders = [];
  }
});

test("blame-derived reviewed additions persist with reviewer attribution", async () => {
  // Regression for the Invalid v4 restart failure: other-user additions start
  // reviewed, so they must carry a lastReviewer or the next startup rejects
  // the whole file. The 1-1 replacement deletion must inherit it too.
  const { storageBase, workspace, storageUri, folder } = await makeFolder();
  try {
    const git = { diff() { return Promise.resolve([]); } } as unknown as import("../src/git.ts").GitService;
    const encoder = new TextEncoder();
    const baseline = encoder.encode("a\nold\n");
    const current = encoder.encode("a\nnew\n");
    const hunks = [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }];
    const me = { name: "Me", email: "me@x.test" };
    const blame = new Map([[2, { line: 2, commit: "a".repeat(40), authorName: "Alice", authorEmail: "alice@x.test" }]]);
    const at = "2026-03-01T12:00:00.000Z";
    const diff = diffMod.buildDiffRecords(baseline, current, hunks, undefined, {
      initialStatusForAddition: blameMod.initialStatusCallback(blame as never, me),
      initialReviewerForAddition: blameMod.initialReviewerCallback(blame as never, me, at),
    });
    assert.equal(diff.currentLines[1]?.reviewStatus, "reviewed");
    assert.deepEqual(diff.currentLines[1]?.lastReviewer, { name: "Alice", email: "alice@x.test", time: at });
    assert.equal(diff.deletedLines[0]?.reviewStatus, "reviewed");
    assert.deepEqual(diff.deletedLines[0]?.lastReviewer, { name: "Alice", email: "alice@x.test", time: at });

    const { digestBytes } = identityMod;
    const { fileStatus } = statusMod;
    const baselineDigest = digestBytes(baseline);
    const currentDigest = digestBytes(current);
    const stored = recordMod.storedFile("blamed.ts", {
      baseline: { file: naming.snapshotFileName("blamed.ts", baselineDigest), digest: baselineDigest, codec: "gzip", size: baseline.byteLength, createdAt: at },
      current: { digest: currentDigest, modifiedAt: 7, size: current.byteLength, gitAlgorithm: "myers", generatedAt: at },
      fileStatus: fileStatus(diff),
      ...diff,
      nextRevExtId: 1,
      updatedAt: at,
    } as never);
    assert.notEqual(schemaMod.parseStoredFile(JSON.parse(JSON.stringify(stored))), undefined, "blame-reviewed record must satisfy v4 validation");

    // It must also survive a real store restart, not just an in-memory parse.
    const store = new storeMod.PersistentStore(folder, fakeLog as unknown as import("vscode").LogOutputChannel, storageUri);
    await store.initialize();
    await store.enableTracking([{ kind: "folder", path: "" }]);
    const source = { modifiedAt: Date.now(), size: current.byteLength };
    const record = await sourceIo.createRecord(git, "blamed.txt", baseline, current, source, undefined, hunks);
    // createRecord has no blame context, so rebuild with the classified diff.
    await store.commit("blamed.txt", { ...record, ...diff, fileStatus: fileStatus(diff) }, baseline);
    const restarted = new storeMod.PersistentStore(folder, fakeLog as unknown as import("vscode").LogOutputChannel, storageUri);
    await restarted.initialize();
    const loaded = await restarted.load("blamed.txt");
    assert.ok(loaded, "blame-reviewed record must load after restart");
    assert.equal(loaded.currentLines[1]?.reviewStatus, "reviewed");
    assert.deepEqual(loaded.currentLines[1]?.lastReviewer, { name: "Alice", email: "alice@x.test", time: at });
  } finally {
    await rm(storageBase, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    fakeWorkspaceFolders = [];
  }
});

test("commit refuses reviewed-without-reviewer with a detailed error", async () => {
  // The store used to write blame-reviewed lines without attribution, which
  // only failed later at startup. Commits must now fail fast with the exact
  // invariant instead of producing a file that breaks the next restart.
  const { storageBase, workspace, storageUri, folder } = await makeFolder();
  try {
    const encoder = new TextEncoder();
    const baseline = encoder.encode("a\n");
    const current = encoder.encode("a\nnew\n");
    const hunks = [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 }];
    const diff = diffMod.buildDiffRecords(baseline, current, hunks, undefined, {
      initialStatusForAddition: () => "reviewed" as const,
    });
    assert.equal(diff.currentLines[1]?.reviewStatus, "reviewed");
    assert.equal(diff.currentLines[1]?.lastReviewer, undefined);

    const { digestBytes } = identityMod;
    const { fileStatus } = statusMod;
    const baselineDigest = digestBytes(baseline);
    const currentDigest = digestBytes(current);
    const at = "2026-03-01T12:00:00.000Z";
    const invalid = {
      baseline: { file: naming.snapshotFileName("bad.txt", baselineDigest), digest: baselineDigest, codec: "gzip", size: baseline.byteLength, createdAt: at },
      current: { digest: currentDigest, modifiedAt: 7, size: current.byteLength, gitAlgorithm: "myers", generatedAt: at },
      fileStatus: fileStatus(diff),
      ...diff,
      nextRevExtId: 1,
      updatedAt: at,
    } as never;

    const store = new storeMod.PersistentStore(folder, fakeLog as unknown as import("vscode").LogOutputChannel, storageUri);
    await store.initialize();
    await store.enableTracking([{ kind: "folder", path: "" }]);
    await assert.rejects(
      () => store.commit("bad.txt", invalid, baseline),
      (error: unknown) => {
        const message = String(error);
        assert.match(message, /Refusing to persist invalid v4/);
        assert.match(message, /bad\.txt/);
        assert.match(message, /lastReviewer/);
        return true;
      },
      "commit must reject reviewed-without-reviewer with reviewer detail",
    );
  } finally {
    await rm(storageBase, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    fakeWorkspaceFolders = [];
  }
});

test("describeStoredFileProblem names the exact broken invariant", async () => {
  const { describeStoredFileProblem, parseStoredFile } = schemaMod;
  const { storedFile } = recordMod;
  const { buildDiffRecords } = diffMod;
  const { digestBytes } = identityMod;
  const { fileStatus } = statusMod;
  const encoder = new TextEncoder();
  const baseline = encoder.encode("a\nb\n");
  const current = encoder.encode("a\nc\n");
  const diff = buildDiffRecords(baseline, current, [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }]);
  const baselineDigest = digestBytes(baseline);
  const at = "2026-03-01T12:00:00.000Z";
  const valid = storedFile("src/example.ts", {
    baseline: { file: naming.snapshotFileName("src/example.ts", baselineDigest), digest: baselineDigest, codec: "gzip", size: baseline.byteLength, createdAt: at },
    current: { digest: digestBytes(current), modifiedAt: 7, size: current.byteLength, gitAlgorithm: "myers", generatedAt: at },
    fileStatus: fileStatus(diff),
    ...diff,
    nextRevExtId: 1,
    updatedAt: at,
  } as never);
  const persisted = JSON.parse(JSON.stringify(valid));

  // Path mismatch (metadata file named for another source).
  assert.match(describeStoredFileProblem(persisted, "src/other.ts"), /does not match expected path/);
  // Snapshot name drift.
  assert.match(
    describeStoredFileProblem({ ...persisted, file: { ...persisted.file, baseline: { ...persisted.file.baseline, file: "other.gz" } } }, "src/example.ts"),
    /snapshot name mismatch/,
  );
  // Reviewer attribution missing on a reviewed addition (fileStatus updated to
  // match so the diagnostic reaches the line-level check).
  const reviewedWithoutReviewer = {
    ...persisted,
    file: {
      ...persisted.file,
      fileStatus: "inReview",
      currentLines: persisted.file.currentLines.map((line: { changeType: string }) =>
        line.changeType === "added" ? { ...line, reviewStatus: "reviewed" } : line,
      ),
    },
  };
  assert.equal(parseStoredFile(reviewedWithoutReviewer), undefined);
  assert.match(describeStoredFileProblem(reviewedWithoutReviewer, "src/example.ts"), /no lastReviewer/);
  // Hunk coverage drift.
  assert.match(
    describeStoredFileProblem({ ...persisted, file: { ...persisted.file, hunks: [] } }, "src/example.ts"),
    /hunk coverage mismatch/,
  );
});
