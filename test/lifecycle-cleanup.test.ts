import assert from "node:assert/strict";
import Module from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type * as vscode from "vscode";
import type { PersistentStore } from "../src/store.ts";
import type { CleanupDeps } from "../src/review-service/lifecycle/deps.ts";

class Uri {
  constructor(readonly path: string) {}
  toString(): string {
    return `file://${this.path}`;
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri([base.path, ...parts].join("/"));
  }
}
const folder = { uri: new Uri("/workspace") } as unknown as vscode.WorkspaceFolder;
const moduleLoader = Module as unknown as {
  _load(request: string, parent?: unknown, isMain?: unknown): unknown;
};
const originalLoad = moduleLoader._load.bind(moduleLoader);
moduleLoader._load = (request, parent, isMain) => {
  if (request === "vscode") {
    return {
      Uri,
      workspace: { getWorkspaceFolder: () => folder },
    };
  }
  return originalLoad(request, parent, isMain);
};
let cleanup: typeof import("../src/review-service/lifecycle/cleanup.ts");
let gateModule: typeof import("../src/review-service/gate.ts");
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  cleanup = require("../src/review-service/lifecycle/cleanup.ts") as typeof cleanup;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  gateModule = require("../src/review-service/gate.ts") as typeof gateModule;
} finally {
  moduleLoader._load = originalLoad;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(): {
  deps: CleanupDeps;
  gate: InstanceType<typeof gateModule.SourceGate>;
  records: Set<string>;
  warnings: string[];
  notifications: string[];
} {
  const records = new Set(["source.txt"]);
  const warnings: string[] = [];
  const notifications: string[] = [];
  const gate = new gateModule.SourceGate();
  const store = {
    get paths() { return [...records]; },
    delete(path: string) {
      records.delete(path);
      return Promise.resolve();
    },
  } as unknown as PersistentStore;
  const deps: CleanupDeps = {
    log: {
      warn: (message: string) => warnings.push(message),
      info: (message: string) => notifications.push(message),
    } as unknown as vscode.LogOutputChannel,
    storeForFolder: () => store,
    withSource: (uri, operation) => gate.withSource(uri, operation),
    notifyChanged: () => notifications.push("changed"),
  };
  return { deps, gate, records, warnings, notifications };
}

const source = new Uri("/workspace/source.txt") as unknown as vscode.Uri;

test("ignored-source deletion waits for the current source write", async () => {
  const { deps, gate, records, notifications } = setup();
  const blocked = deferred();
  const writer = gate.withSource(source, async () => {
    await blocked.promise;
    records.add("source.txt");
  });
  const deleting = cleanup.cleanupIgnoredSources(
    deps, folder, () => Promise.resolve(new Set(["source.txt"])),
  );
  await setImmediate();
  assert.equal(records.has("source.txt"), true, "cleanup must not race an active writer");
  blocked.resolve();
  await Promise.all([writer, deleting]);
  assert.deepEqual([...records], [], "the completed writer must not resurrect ignored metadata");
  assert.deepEqual(notifications, ["Removed metadata for 1 ignored files.", "changed"]);
});

test("queued ignore cleanup preserves files re-included before its turn", async () => {
  const { deps, gate, records, notifications } = setup();
  const blocked = deferred();
  let ignored = true;
  const writer = gate.withSource(source, () => blocked.promise);
  const deleting = cleanup.cleanupIgnoredSources(
    deps, folder, () => Promise.resolve(new Set(ignored ? ["source.txt"] : [])),
  );
  await setImmediate();
  ignored = false;
  blocked.resolve();
  await Promise.all([writer, deleting]);
  assert.deepEqual([...records], ["source.txt"]);
  assert.deepEqual(notifications, []);
});

test("ignore evaluation failure after queueing preserves existing metadata", async () => {
  const { deps, records, warnings, notifications } = setup();
  let checks = 0;
  await cleanup.cleanupIgnoredSources(deps, folder, () => {
    checks += 1;
    if (checks > 1) {
      return Promise.reject(new Error("ignore rules unavailable"));
    }
    return Promise.resolve(new Set(["source.txt"]));
  });
  assert.deepEqual([...records], ["source.txt"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /ignore rules unavailable/);
  assert.deepEqual(notifications, []);
});
