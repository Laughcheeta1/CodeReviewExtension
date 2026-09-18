import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import test, { beforeEach } from "node:test";
import type { ReviewService } from "../src/review-service.ts";

const source = { scheme: "file", fsPath: "/workspace/source.ts" };
const folder = { uri: { scheme: "file", fsPath: "/workspace" } };
const editor = {
  document: { uri: source, getText: () => "echo first\necho second\n" },
  selections: [{ isEmpty: false, start: { line: 0 }, end: { line: 2, character: 0 } }],
};
const sent: [string, boolean][] = [];
const terminal = { sendText: (text: string, newline: boolean) => sent.push([text, newline]), show: () => {} };
let trusted = true;
let agentCommand = " agent --interactive ";
let activeTerminal: typeof terminal | undefined;
let activeEditor: typeof editor | undefined;
let relativePath: string | undefined;
const creations: unknown[] = [];
const configurations: unknown[][] = [];
const warnings: unknown[] = [];
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
    showWarningMessage: (...args: unknown[]) => {
      warnings.push(args);
      throw new Error("terminal confirmation prompt must not appear");
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

test("sends selection without confirmation, starting the agent on terminal creation", () => {
  commands.sendSelection(service);
  assert.deepEqual(warnings, []);
  assert.deepEqual(creations, [{ name: "Code Review Agent", cwd: folder.uri }]);
  assert.deepEqual(configurations, [["codeReviewTracker", source]]);
  assert.deepEqual(sent, [["agent --interactive", true], [expectedPayload, false]]);
});

test("existing terminal receives payload directly and starts no agent", () => {
  activeTerminal = terminal;
  commands.sendSelection(service);
  commands.sendSelection(service);
  assert.deepEqual(warnings, []);
  assert.deepEqual(sent, [[expectedPayload, false], [expectedPayload, false]]);
  assert.deepEqual(creations, []);
  assert.deepEqual(configurations, []);
});

test("Restricted Mode sends payload but never executes configured agent", () => {
  trusted = false;
  commands.sendSelection(service);
  assert.equal(creations.length, 1);
  assert.deepEqual(sent, [[expectedPayload, false]]);
});

test("blank agent configuration sends only the selection", () => {
  agentCommand = "   ";
  commands.sendSelection(service);
  assert.deepEqual(sent, [[expectedPayload, false]]);
});

test("missing editor or workspace source has no terminal side effects", () => {
  activeEditor = undefined;
  commands.sendSelection(service);
  activeEditor = {
    ...editor,
    document: { ...editor.document, uri: { ...source, scheme: "untitled" } },
  };
  commands.sendSelection(service);
  activeEditor = editor;
  relativePath = undefined;
  commands.sendSelection(service);
  assert.deepEqual(warnings, []);
  assert.deepEqual(creations, []);
  assert.deepEqual(sent, []);
});
