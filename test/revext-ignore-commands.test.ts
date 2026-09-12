import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { posix } from "node:path";
import test, { beforeEach } from "node:test";
import type * as vscode from "vscode";

class Uri {
  readonly scheme = "file";
  constructor(readonly fsPath: string) {}
  toString(): string {
    return `file://${this.fsPath}`;
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(posix.join(base.fsPath, ...parts));
  }
}

const folder = { uri: new Uri("/workspace"), name: "workspace", index: 0 };
const warnings: string[] = [];
let content: string | undefined;
let writes = 0;
let dirty = false;
class FileSystemError extends Error {
  readonly code = "FileNotFound";
}
const fakeVscode = {
  Uri,
  FileSystemError,
  FileType: { Directory: 2 },
  workspace: {
    getWorkspaceFolder: () => folder,
    asRelativePath: (uri: Uri) => posix.relative(folder.uri.fsPath, uri.fsPath),
    get textDocuments() {
      return [{ uri: new Uri("/workspace/.vscode/review-extension.json"), isDirty: dirty }];
    },
    fs: {
      async readFile(): Promise<Uint8Array> {
        const snapshot = content;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (snapshot === undefined) {
          throw new FileSystemError();
        }
        return new TextEncoder().encode(snapshot);
      },
      writeFile(_uri: Uri, bytes: Uint8Array): Promise<void> {
        writes += 1;
        content = new TextDecoder().decode(bytes);
        return Promise.resolve();
      },
      createDirectory: () => Promise.resolve(),
      stat: () => Promise.resolve({ type: 2 }),
    },
  },
  window: {
    showWarningMessage(message: string): void {
      warnings.push(message);
    },
    showInformationMessage(): void {},
  },
};
const loader = Module as unknown as {
  _load: (request: string, parent?: unknown, isMain?: boolean) => unknown;
};
const originalLoad = loader._load;
const loadModule = createRequire(__filename);
let commands: typeof import("../src/review-commands/revext-ignore.ts");
try {
  loader._load = (request, parent, isMain) => request === "vscode"
    ? fakeVscode
    : originalLoad(request, parent, isMain);
  commands = loadModule("../src/review-commands/revext-ignore.ts") as typeof commands;
} finally {
  loader._load = originalLoad;
}

function uri(path: string): vscode.Uri {
  return new Uri(path) as unknown as vscode.Uri;
}

beforeEach(() => {
  content = undefined;
  writes = 0;
  dirty = false;
  warnings.length = 0;
});

test("concurrent ignore commands preserve every entry and unrelated config", async () => {
  content = JSON.stringify({ custom: { enabled: true } });
  await Promise.all([
    commands.ignoreFileForRevExt(uri("/workspace/a.ts")),
    commands.ignoreFileForRevExt(uri("/workspace/b.ts")),
    commands.ignoreExtensionForRevExt(uri("/workspace/c.TSX")),
  ]);
  assert.deepEqual(JSON.parse(content) as unknown, {
    custom: { enabled: true },
    revExtIgnoredFiles: ["a.ts", "b.ts"],
    revExtIgnoredExtensions: [".tsx"],
  });
  assert.deepEqual(warnings, []);
});

test("ignore commands preserve malformed and non-object config", async () => {
  for (const invalid of ["{", "[]", "null", '"config"']) {
    content = invalid;
    await commands.ignoreFileForRevExt(uri("/workspace/a.ts"));
    assert.equal(content, invalid);
  }
  assert.equal(writes, 0);
  assert.equal(warnings.length, 4);
});

test("ignore commands reject dirty configuration and recover after saving", async () => {
  content = "{}";
  dirty = true;
  await commands.ignoreFileForRevExt(uri("/workspace/a.ts"));
  assert.equal(writes, 0);
  assert.match(warnings[0]!, /Save .*review-extension.json/);
  dirty = false;
  await commands.ignoreFileForRevExt(uri("/workspace/b.ts"));
  assert.deepEqual(JSON.parse(content) as unknown, { revExtIgnoredFiles: ["b.ts"] });
});

test("ignore folder accepts the workspace root", async () => {
  await commands.ignoreFolderForRevExt(uri("/workspace"));
  assert.deepEqual(JSON.parse(content!) as unknown, { revExtIgnoredFolders: ["."] });
  assert.deepEqual(warnings, []);
});
