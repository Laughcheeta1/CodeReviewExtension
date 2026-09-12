import assert from "node:assert/strict";
import Module from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type * as vscode from "vscode";
import type { GitIgnoreService } from "../src/git-ignore.ts";

let discover: () => Promise<readonly string[]>;
const moduleLoader = Module as unknown as {
  _load(request: string, parent?: unknown, isMain?: unknown): unknown;
};
const originalLoad = moduleLoader._load.bind(moduleLoader);
moduleLoader._load = (request, parent, isMain) => {
  if (request === "vscode") {
    return {};
  }
  if (request === "../workspace-discovery") {
    return { eligibleWorkspacePaths: () => discover() };
  }
  return originalLoad(request, parent, isMain);
};
let eligibility: typeof import("../src/review-service/eligibility.ts");
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  eligibility = require("../src/review-service/eligibility.ts") as typeof eligibility;
} finally {
  moduleLoader._load = originalLoad;
}

test("forced discovery after a creation event cannot reuse an earlier filesystem scan", async () => {
  let finishEarlierScan!: (paths: readonly string[]) => void;
  const earlierScan = new Promise<readonly string[]>((resolve) => {
    finishEarlierScan = resolve;
  });
  let scans = 0;
  discover = () => {
    scans += 1;
    return scans === 1 ? earlierScan : Promise.resolve(["old.txt", "new.txt"]);
  };
  const folder = {
    uri: { toString: () => "file:///workspace" },
  } as unknown as vscode.WorkspaceFolder;
  const tracker = new eligibility.EligibilityTracker(
    new Map(),
    {} as GitIgnoreService,
    { warn: assert.fail } as unknown as vscode.LogOutputChannel,
    () => {},
  );
  const earlier = tracker.refreshEligiblePaths(folder, true);
  await setImmediate();
  // The creation event occurs after the earlier scan captured its file list.
  const created = tracker.refreshEligiblePaths(folder, true);
  const simultaneousChange = tracker.refreshEligiblePaths(folder, true);
  assert.equal(scans, 1, "workspace scans should remain serialized");
  finishEarlierScan(["old.txt"]);
  assert.deepEqual(await earlier, ["old.txt"]);
  assert.deepEqual(await created, ["old.txt", "new.txt"]);
  assert.deepEqual(await simultaneousChange, ["old.txt", "new.txt"]);
  assert.equal(scans, 2, "simultaneous invalidations should share the next scan");
  assert.deepEqual(await tracker.refreshEligiblePaths(folder), ["old.txt", "new.txt"]);
});
