import assert from "node:assert/strict";
import Module from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type * as vscode from "vscode";
import type { ReviewService } from "../src/review-service.ts";
import type { GitIgnoreService } from "../src/git-ignore.ts";

type Listener = () => void;
class Watcher {
  create: Listener = () => {};
  change: Listener = () => {};
  delete: Listener = () => {};
  onDidCreate(listener: Listener): vscode.Disposable {
    this.create = listener;
    return { dispose() {} };
  }
  onDidChange(listener: Listener): vscode.Disposable {
    this.change = listener;
    return { dispose() {} };
  }
  onDidDelete(listener: Listener): vscode.Disposable {
    this.delete = listener;
    return { dispose() {} };
  }
  dispose(): void {}
}
const watchers: Watcher[] = [];
let refresh: () => Promise<void> = () => Promise.resolve();
const moduleLoader = Module as unknown as {
  _load(request: string, parent?: unknown, isMain?: unknown): unknown;
};
const originalLoad = moduleLoader._load.bind(moduleLoader);
moduleLoader._load = (request, parent, isMain) => {
  if (request === "vscode") {
    return {
      RelativePattern: class {},
      workspace: {
        createFileSystemWatcher() {
          const watcher = new Watcher();
          watchers.push(watcher);
          return watcher;
        },
      },
    };
  }
  if (request === "./startup") {
    return { refreshFolder: () => refresh() };
  }
  return originalLoad(request, parent, isMain);
};
let watchWorkspace: typeof import("../src/extension/watchers.ts").watchWorkspace;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  watchWorkspace = (require("../src/extension/watchers.ts") as typeof import("../src/extension/watchers.ts")).watchWorkspace;
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

function setup(initialize: () => Promise<void>): { watcher: Watcher; warnings: string[] } {
  watchers.length = 0;
  const warnings: string[] = [];
  watchWorkspace(
    { subscriptions: [] } as unknown as vscode.ExtensionContext,
    {} as vscode.WorkspaceFolder,
    { initializeDiscoveredSources: initialize } as unknown as ReviewService,
    {} as GitIgnoreService,
    { warn: (message: string) => warnings.push(message) } as unknown as vscode.LogOutputChannel,
  );
  assert.equal(watchers.length, 2);
  return { watcher: watchers[1]!, warnings };
}

test("ignore watcher reconciles the latest rules after edits during initialization", async () => {
  const blocked = deferred();
  let diskRules = "initial";
  let activeRules = "";
  let refreshCount = 0;
  const initializedRules: string[] = [];
  refresh = () => {
    refreshCount += 1;
    activeRules = diskRules;
    return Promise.resolve();
  };
  const { watcher, warnings } = setup(async () => {
    initializedRules.push(activeRules);
    if (initializedRules.length === 1) {
      await blocked.promise;
    }
  });
  watcher.change();
  await setImmediate();
  diskRules = "intermediate";
  watcher.create();
  diskRules = "final";
  watcher.delete();
  assert.equal(refreshCount, 1, "in-flight passes must stay serialized");
  blocked.resolve();
  await setImmediate();
  assert.equal(refreshCount, 2, "a burst needs one trailing refresh");
  assert.deepEqual(initializedRules, ["initial", "final"]);
  assert.deepEqual(warnings, []);

  diskRules = "later";
  watcher.change();
  await setImmediate();
  assert.deepEqual(initializedRules, ["initial", "final", "later"]);
});

test("ignore watcher retries a queued edit even when the current pass fails", async () => {
  const blocked = deferred();
  let calls = 0;
  refresh = () => Promise.resolve();
  const { watcher, warnings } = setup(async () => {
    calls += 1;
    if (calls === 1) {
      await blocked.promise;
      throw new Error("initialization interrupted");
    }
  });
  watcher.change();
  await setImmediate();
  watcher.change();
  blocked.resolve();
  await setImmediate();
  assert.equal(calls, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /initialization interrupted/);
});
