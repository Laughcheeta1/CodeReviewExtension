import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import type * as vscode from "vscode";

class Uri {
  constructor(readonly fsPath: string) {}
  toString(): string {
    return `file://${this.fsPath}`;
  }
}
const parent = { uri: new Uri("/workspace") };
const child = { uri: new Uri("/workspace/child") };
const roots = [child, parent];
const files = new Map([
  ["/workspace/.gitignore", "parent-secret.txt\n"],
  ["/workspace/parent-secret.txt", "secret"],
  ["/workspace/child-only.txt", "parent source"],
  ["/workspace/main.txt", "parent source"],
  ["/workspace/child/.gitignore", "child-only.txt\n"],
  ["/workspace/child/child-only.txt", "child secret"],
  ["/workspace/child/parent-secret.txt", "child source"],
  ["/workspace/child/main.txt", "child source"],
]);
function owner(uri: Uri): typeof parent | undefined {
  return roots.find((folder) => uri.fsPath.startsWith(`${folder.uri.fsPath}/`));
}
class RelativePattern {
  constructor(readonly folder: typeof parent, readonly pattern: string) {}
}
const moduleLoader = Module as unknown as {
  _load(request: string, parent?: unknown, isMain?: unknown): unknown;
};
const originalLoad = moduleLoader._load.bind(moduleLoader);
moduleLoader._load = (request, parentModule, isMain) => {
  if (request === "vscode") {
    return {
      RelativePattern,
      workspace: {
        getWorkspaceFolder: owner,
        asRelativePath(uri: Uri) {
          const folder = owner(uri);
          assert.ok(folder);
          return uri.fsPath.slice(folder.uri.fsPath.length + 1);
        },
        findFiles(pattern: RelativePattern) {
          return Promise.resolve([...files.keys()]
            .filter((path) => path.startsWith(`${pattern.folder.uri.fsPath}/`))
            .filter((path) => pattern.pattern !== "**/.gitignore" || path.endsWith("/.gitignore"))
            .map((path) => new Uri(path)));
        },
        fs: {
          readFile(uri: Uri) {
            const contents = files.get(uri.fsPath);
            assert.notEqual(contents, undefined);
            return Promise.resolve(new TextEncoder().encode(contents));
          },
        },
      },
    };
  }
  return originalLoad(request, parentModule, isMain);
};
let discovery: typeof import("../src/workspace-discovery.ts");
let ignoreModule: typeof import("../src/git-ignore.ts");
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  discovery = require("../src/workspace-discovery.ts") as typeof discovery;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ignoreModule = require("../src/git-ignore.ts") as typeof ignoreModule;
} finally {
  moduleLoader._load = originalLoad;
}

test("nested workspace roots retain independent source paths and ignore rules", async () => {
  const rules = new ignoreModule.GitIgnoreService();
  const parentPaths = await discovery.eligibleWorkspacePaths(parent as unknown as vscode.WorkspaceFolder, rules);
  const childPaths = await discovery.eligibleWorkspacePaths(child as unknown as vscode.WorkspaceFolder, rules);
  assert.deepEqual([...parentPaths].sort(), [".gitignore", "child-only.txt", "main.txt"]);
  assert.deepEqual([...childPaths].sort(), [".gitignore", "main.txt", "parent-secret.txt"]);
  assert.equal(new Set(parentPaths).size, parentPaths.length, "nested files must not duplicate parent paths");
  assert.deepEqual([...await rules.ignoredPaths(parent as unknown as vscode.WorkspaceFolder, ["parent-secret.txt", "child-only.txt"])], ["parent-secret.txt"]);
  assert.deepEqual([...await rules.ignoredPaths(child as unknown as vscode.WorkspaceFolder, ["parent-secret.txt", "child-only.txt"])], ["child-only.txt"]);
});
