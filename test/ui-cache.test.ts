import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import type * as vscode from "vscode";
import type { ReviewSummary } from "../src/review-service";

class Emitter<T> {
  readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): vscode.Disposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

const documents = new Emitter<{ document: vscode.TextDocument }>();
const windowStub = {
  visibleTextEditors: [] as vscode.TextEditor[],
  createTextEditorDecorationType: () => ({ dispose: () => {} }),
};
const loader = Module as unknown as {
  _load(this: void, request: string, parent?: unknown, isMain?: unknown): unknown;
};
const originalLoad = loader._load;
let ReviewTree: typeof import("../src/ui/tree").ReviewTree;
let ReviewDecorations: typeof import("../src/ui/decorations").ReviewDecorations;
try {
  loader._load = function (request, parent, isMain) {
    if (request === "vscode") {
      return {
        EventEmitter: Emitter,
        window: windowStub,
        workspace: { onDidChangeTextDocument: documents.event },
        Uri: { parse: (value: string) => ({ toString: () => value }) },
        Range: class {
          constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {}
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- load after installing the VS Code runtime stub.
  ({ ReviewTree } = require("../src/ui/tree") as typeof import("../src/ui/tree"));
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- load after installing the VS Code runtime stub.
  ({ ReviewDecorations } = require("../src/ui/decorations") as typeof import("../src/ui/decorations"));
} finally {
  loader._load = originalLoad;
}

function uri(value: string): vscode.Uri {
  return { toString: () => value } as vscode.Uri;
}

test("tree shares one sorted snapshot across groups and invalidates on service changes", async () => {
  const changes = new Emitter<vscode.Uri | undefined>();
  let calls = 0;
  const files: ReviewSummary[] = [
    { uri: uri("z"), path: "z", status: "pending", reviewed: 0, total: 1 },
    { uri: uri("a"), path: "a", status: "pending", reviewed: 0, total: 1 },
  ];
  const tree = new ReviewTree({ onDidChange: changes.event, summary: () => { calls += 1; return files; } });
  const nodes = await tree.getChildren({ kind: "group", status: "pending" });
  assert.deepEqual(nodes?.map((node) => node.kind === "file" ? node.label : undefined), ["a", "z"]);
  assert.deepEqual(files.map((file) => file.path), ["z", "a"], "sorting must not mutate service output");
  await tree.getChildren({ kind: "group", status: "reviewed" });
  assert.equal(calls, 1);
  files[0] = { ...files[0]!, status: "reviewed" };
  changes.fire(undefined);
  assert.equal((await tree.getChildren({ kind: "group", status: "reviewed" }))?.length, 1);
  assert.equal(calls, 2);
  tree.dispose();
  assert.equal(changes.listeners.size, 0);
});

test("decoration cache follows document versions and language changes and cancels disposed refreshes", async () => {
  const changes = new Emitter<vscode.Uri | undefined>();
  let scans = 0;
  let writes = 0;
  const document = {
    uri: uri("source.ts"), version: 1, languageId: "typescript", lineCount: 1,
    lineAt: () => { scans += 1; return { text: "source  // RevExt: 1" }; },
  } as unknown as vscode.TextDocument;
  windowStub.visibleTextEditors = [{ document, setDecorations: () => { writes += 1; } } as unknown as vscode.TextEditor];
  const decorations = new ReviewDecorations({
    onDidChange: changes.event, parseBaselineUri: () => undefined,
    isTrackable: () => false, ensureDocument: async () => {}, file: () => undefined,
  });
  try {
    decorations.refresh();
    decorations.refresh();
    await Promise.resolve();
    assert.equal(scans, 1);
    assert.equal(writes, 4, "refreshes coalesce to one decoration pass");
    changes.fire(undefined);
    await Promise.resolve();
    assert.equal(scans, 1);
    Object.assign(document, { version: 2 });
    documents.fire({ document });
    await Promise.resolve();
    assert.equal(scans, 2);
    Object.assign(document, { languageId: "python" });
    documents.fire({ document });
    await Promise.resolve();
    assert.equal(scans, 3);
    const beforeDispose = writes;
    decorations.refresh();
    decorations.dispose();
    await Promise.resolve();
    assert.equal(writes, beforeDispose, "queued refresh must not use disposed decoration types");
    assert.equal(changes.listeners.size, 0);
    assert.equal(documents.listeners.size, 0);
  } finally {
    decorations.dispose();
    windowStub.visibleTextEditors = [];
  }
});
