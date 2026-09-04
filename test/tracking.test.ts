import assert from "node:assert/strict";
import test from "node:test";
import {
  parseInitializationConfiguration,
  tracksPath,
  type InitializationConfiguration,
  type TrackingTarget,
} from "../src/tracking.ts";

function initialized(
  targets: readonly TrackingTarget[],
): InitializationConfiguration {
  return { schemaVersion: 1, state: "initialized", targets };
}

test("parses the disabled and initialized configurations", () => {
  assert.deepEqual(parseInitializationConfiguration({
    schemaVersion: 1,
    state: "disabled",
  }), { schemaVersion: 1, state: "disabled" });
  assert.deepEqual(
    parseInitializationConfiguration({
      schemaVersion: 1,
      state: "initialized",
      targets: [
        { kind: "file", path: "src/a.ts" },
        { kind: "folder", path: "" },
      ],
    }),
    {
      schemaVersion: 1,
      state: "initialized",
      targets: [
        { kind: "file", path: "src/a.ts" },
        { kind: "folder", path: "" },
      ],
    },
  );
});

test("rejects every malformed initialization shape", () => {
  assert.equal(parseInitializationConfiguration(undefined), undefined);
  assert.equal(parseInitializationConfiguration({}), undefined);
  assert.equal(
    parseInitializationConfiguration({ schemaVersion: 2, state: "disabled" }),
    undefined,
  );
  assert.equal(
    parseInitializationConfiguration({ schemaVersion: 1, state: "other" }),
    undefined,
  );
  assert.equal(
    parseInitializationConfiguration({ schemaVersion: 1, state: "initialized" }),
    undefined,
  );
  assert.equal(
    parseInitializationConfiguration({
      schemaVersion: 1,
      state: "initialized",
      targets: [],
    }),
    undefined,
  );
  assert.equal(
    parseInitializationConfiguration({
      schemaVersion: 1,
      state: "initialized",
      targets: [{ kind: "file", path: "" }],
    }),
    undefined,
  );
  assert.equal(
    parseInitializationConfiguration({
      schemaVersion: 1,
      state: "initialized",
      targets: [{ kind: "file", path: "a/../b.ts" }],
    }),
    undefined,
  );
  assert.equal(
    parseInitializationConfiguration({
      schemaVersion: 1,
      state: "initialized",
      targets: [{ kind: "file", path: "a\\b.ts" }],
    }),
    undefined,
  );
  assert.equal(
    parseInitializationConfiguration({
      schemaVersion: 1,
      state: "initialized",
      targets: [{ kind: "symlink", path: "a.ts" }],
    }),
    undefined,
  );
  assert.equal(
    parseInitializationConfiguration({
      schemaVersion: 1,
      state: "initialized",
      targets: [{ kind: "folder", path: "." }],
    }),
    undefined,
  );
});

test("tracksPath matches files, folders, and the workspace root", () => {
  assert.equal(tracksPath("src/a.ts", undefined), false);
  assert.equal(
    tracksPath("src/a.ts", { schemaVersion: 1, state: "disabled" }),
    false,
  );
  const files = initialized([{ kind: "file", path: "src/a.ts" }]);
  assert.equal(tracksPath("src/a.ts", files), true);
  assert.equal(tracksPath("src/b.ts", files), false);
  const folder = initialized([{ kind: "folder", path: "src" }]);
  assert.equal(tracksPath("src", folder), true);
  assert.equal(tracksPath("src/a.ts", folder), true);
  assert.equal(tracksPath("src-other/a.ts", folder), false);
  assert.equal(tracksPath("other/a.ts", folder), false);
  const root = initialized([{ kind: "folder", path: "" }]);
  assert.equal(tracksPath("anything/deep.ts", root), true);
});
