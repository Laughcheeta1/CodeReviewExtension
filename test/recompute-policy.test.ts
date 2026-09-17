import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import test from "node:test";
import type * as vscode from "vscode";
import type { GitService } from "../src/git.ts";
import type { PersistentStore } from "../src/store.ts";
import type { FileRecord, ReviewStatus } from "../src/domain.ts";

const folder = { uri: { fsPath: "/workspace" } };
const fakeVscode = { workspace: { getWorkspaceFolder: () => folder } };
const loader = Module as unknown as {
  _load: (request: string, parent?: unknown, isMain?: boolean) => unknown;
};
const originalLoad = loader._load;
const loadModule = createRequire(__filename);
let recompute: typeof import("../src/review-service/recompute.ts");
let sourceIo: typeof import("../src/source-io.ts");
try {
  loader._load = (request, parent, isMain) => request === "vscode"
    ? fakeVscode
    : originalLoad(request, parent, isMain);
  recompute = loadModule("../src/review-service/recompute.ts") as typeof recompute;
  sourceIo = loadModule("../src/source-io.ts") as typeof sourceIo;
} finally {
  loader._load = originalLoad;
}

async function fixture(status: ReviewStatus, emptyBaseline = false) {
  const baseline = Buffer.from(emptyBaseline ? "" : "stable\n\n");
  const current = Buffer.from("stable\nadded\n");
  const rawHunks = emptyBaseline
    ? [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }]
    : [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }];
  let blameCalls = 0;
  let reviewerCalls = 0;
  let baselineReads = 0;
  let committed: FileRecord | undefined;
  const git = {
    blame: () => {
      blameCalls += 1;
      return Promise.resolve(new Map([2, 3].map((line) => [line, {
        line, commit: "a".repeat(40), authorName: "Alice", authorEmail: "alice@example.test",
      }])));
    },
    reviewer: () => {
      reviewerCalls += 1;
      return Promise.resolve({ name: "Bob", email: "bob@example.test" });
    },
  } as unknown as GitService;
  const file = await sourceIo.createRecord(git, "file.txt", baseline, current,
    { modifiedAt: 1, size: current.length }, undefined, rawHunks);
  const storedReviewer = { name: "Stored reviewer", time: "2026-01-01T00:00:00.000Z" };
  const previous: FileRecord = {
    ...file,
    currentLines: file.currentLines.map((line) => line.changeType === "added"
      ? { ...line, reviewStatus: status, lastReviewer: status === "pending" ? undefined : storedReviewer }
      : line),
  };
  const deps: import("../src/review-service/recompute.ts").RecomputeDeps = {
    git,
    log: { warn: () => assert.fail("classification must not fail") } as unknown as vscode.LogOutputChannel,
    isEligibleSource: () => Promise.resolve(true),
    relativePath: () => "file.txt",
    storeFor: () => ({
      loadBaseline: () => {
        baselineReads += 1;
        return Promise.resolve(baseline);
      },
      commit: (_path: string, value: FileRecord) => {
        committed = value;
        return Promise.resolve();
      },
    }) as unknown as PersistentStore,
    maxSize: () => 1024,
    ignoreEmptyLineDeletions: () => true,
    promoteFile: () => Promise.reject(new Error("remaining addition must not promote")),
  };
  return {
    deps, previous, current, rawHunks,
    committed: () => committed,
    calls: () => ({ blame: blameCalls, reviewer: reviewerCalls }),
    baselineReads: () => baselineReads,
  };
}

test("policy change with an empty baseline skips unchanged-content diff and commit", async () => {
  const state = await fixture("pending", true);
  assert.equal(await recompute.recomputeSource(state.deps, {} as vscode.Uri, true, false, {
    bytes: state.current,
    source: { modifiedAt: 1, size: state.current.length },
  }, state.previous, true), false);
  assert.equal(state.baselineReads(), 0);
  assert.deepEqual(state.calls(), { blame: 0, reviewer: 0 });
  assert.equal(state.committed(), undefined);
});

for (const status of ["pending", "inReview", "reviewed"] as const) {
  test(`policy-only rebuild preserves ${status} decisions without blame or identity lookup`, async () => {
    const state = await fixture(status);
    const changed = await recompute.recomputeSource(state.deps, {} as vscode.Uri, true, false, {
      bytes: state.current,
      source: { modifiedAt: 1, size: state.current.length },
      rawHunks: state.rawHunks,
    }, state.previous, true);
    assert.equal(changed, true);
    assert.deepEqual(state.calls(), { blame: 0, reviewer: 0 });
    assert.ok(state.committed());
    assert.deepEqual(state.committed()?.currentLines, state.previous.currentLines);
    assert.deepEqual(state.committed()?.deletedLines, []);
  });
}

test("policy rebuild with changed saved bytes still classifies genuinely new additions", async () => {
  const state = await fixture("inReview");
  const bytes = Buffer.from("stable\nadded\nnew\n");
  await recompute.recomputeSource(state.deps, {} as vscode.Uri, true, false, {
    bytes,
    source: { modifiedAt: 2, size: bytes.length },
    rawHunks: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 2 }],
  }, state.previous, true);
  assert.deepEqual(state.calls(), { blame: 1, reviewer: 1 });
  assert.deepEqual(state.committed()?.currentLines[1], state.previous.currentLines[1]);
  assert.equal(state.committed()?.currentLines[2]?.reviewStatus, "reviewed");
  assert.equal(state.committed()?.currentLines[2]?.lastReviewer?.name, "Alice");
});
