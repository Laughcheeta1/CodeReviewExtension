import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import test, { beforeEach } from "node:test";
import type * as vscode from "vscode";
import type { ReviewService } from "../src/review-service.ts";

const source = { scheme: "file", fsPath: "/workspace/source.ts" };
const folder = { uri: { scheme: "file", fsPath: "/workspace" } };
const editor = {
  document: { uri: source, getText: () => "echo first\necho second\n" },
  selections: [{ isEmpty: false, start: { line: 0 }, end: { line: 2, character: 0 } }],
};
const sent: [string, boolean][] = [];
const terminal = { sendText: (text: string, newline: boolean) => sent.push([text, newline]), show: () => {} };
let answer: string | undefined;
let approval: (() => Promise<string | undefined>) | undefined;
let trusted = true;
let agentCommand = " agent --interactive ";
let activeTerminal: typeof terminal | undefined;
let activeEditor: typeof editor | undefined;
let relativePath: string | undefined;
const creations: unknown[] = [];
const configurations: unknown[][] = [];
const warnings: { message: string; options: vscode.MessageOptions; actions: string[] }[] = [];
const fakeVscode = {
  workspace: {
    get isTrusted() { return trusted; },
    getWorkspaceFolder: () => folder,
    getConfiguration: (...args: unknown[]) => {
      configurations.push(args);
      return { get: () => agentCommand };
    },
  },
  window: {
    get activeTextEditor() { return activeEditor; },
    get activeTerminal() { return activeTerminal; },
    showWarningMessage: (message: string, options: vscode.MessageOptions, ...actions: string[]) => {
      warnings.push({ message, options, actions });
      return approval?.() ?? Promise.resolve(answer);
    },
    createTerminal: (options: unknown) => {
      creations.push(options);
      return terminal;
    },
  },
};
const loader = Module as unknown as {
  _load: (request: string, parent?: unknown, isMain?: boolean) => unknown;
};
const originalLoad = loader._load;
const loadModule = createRequire(__filename);
let commands: typeof import("../src/review-commands/workspace.ts");
try {
  loader._load = (request, parent, isMain) => request === "vscode"
    ? fakeVscode
    : originalLoad(request, parent, isMain);
  commands = loadModule("../src/review-commands/workspace.ts") as typeof commands;
} finally {
  loader._load = originalLoad;
}
const service = { relativePath: () => relativePath } as unknown as ReviewService;
const expectedPayload = "> Line 1 - 2, file source.ts:\n```\necho first\necho second\n```\n\n";

beforeEach(() => {
  answer = "Send Selection";
  approval = undefined;
  trusted = true;
  agentCommand = " agent --interactive ";
  activeTerminal = undefined;
  activeEditor = editor;
  relativePath = "source.ts";
  sent.length = 0;
  creations.length = 0;
  configurations.length = 0;
  warnings.length = 0;
});

test("approval precedes terminal creation, agent startup, and unchanged payload sending", async () => {
  let approve!: (value: string) => void;
  approval = () => new Promise<string>((resolve) => { approve = resolve; });
  const pending = commands.sendSelection(service);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.options.modal, true);
  assert.match(warnings[0]?.message ?? "", /shell may execute/);
  assert.deepEqual(warnings[0]?.actions, ["Send Selection"]);
  assert.deepEqual(creations, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(configurations, []);
  approve("Send Selection");
  await pending;
  assert.deepEqual(creations, [{ name: "Code Review Agent", cwd: folder.uri }]);
  assert.deepEqual(configurations, [["codeReviewTracker", source]]);
  assert.deepEqual(sent, [["agent --interactive", true], [expectedPayload, false]]);
});

test("cancellation has no terminal or configuration side effects", async () => {
  for (const existing of [undefined, terminal]) {
    activeTerminal = existing;
    answer = undefined;
    await commands.sendSelection(service);
    assert.deepEqual(creations, []);
    assert.deepEqual(sent, []);
    assert.deepEqual(configurations, []);
  }
});

test("existing terminal requires approval on every invocation and starts no agent", async () => {
  activeTerminal = terminal;
  await commands.sendSelection(service);
  answer = undefined;
  await commands.sendSelection(service);
  assert.equal(warnings.length, 2);
  assert.deepEqual(sent, [[expectedPayload, false]]);
  assert.deepEqual(creations, []);
  assert.deepEqual(configurations, []);
});

test("Restricted Mode permits approved payload but never executes configured agent", async () => {
  trusted = false;
  await commands.sendSelection(service);
  assert.equal(creations.length, 1);
  assert.deepEqual(sent, [[expectedPayload, false]]);
});

test("blank agent configuration sends only the approved selection", async () => {
  agentCommand = "   ";
  await commands.sendSelection(service);
  assert.deepEqual(sent, [[expectedPayload, false]]);
});

test("missing editor or workspace source has no terminal side effects or prompt", async () => {
  activeEditor = undefined;
  await commands.sendSelection(service);
  activeEditor = {
    ...editor,
    document: { ...editor.document, uri: { ...source, scheme: "untitled" } },
  };
  await commands.sendSelection(service);
  activeEditor = editor;
  relativePath = undefined;
  await commands.sendSelection(service);
  assert.deepEqual(warnings, []);
  assert.deepEqual(creations, []);
  assert.deepEqual(sent, []);
});
