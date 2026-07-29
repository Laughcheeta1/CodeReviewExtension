import assert from "node:assert/strict";
import test from "node:test";
import {
  parseInitializationConfiguration,
  tracksPath,
} from "../src/tracking.ts";

test("initialization configuration accepts disabled and scoped tracking states", () => {
  const disabled = parseInitializationConfiguration({
    schemaVersion: 1,
    state: "disabled",
  });
  assert.deepEqual(disabled, { schemaVersion: 1, state: "disabled" });

  const initialized = parseInitializationConfiguration({
    schemaVersion: 1,
    state: "initialized",
    targets: [
      { kind: "folder", path: "src" },
      { kind: "file", path: "README.md" },
    ],
  });
  assert.deepEqual(initialized, {
    schemaVersion: 1,
    state: "initialized",
    targets: [
      { kind: "folder", path: "src" },
      { kind: "file", path: "README.md" },
    ],
  });
});

test("tracked paths stay inside the selected file and folder scopes", () => {
  const configuration = parseInitializationConfiguration({
    schemaVersion: 1,
    state: "initialized",
    targets: [
      { kind: "folder", path: "src" },
      { kind: "file", path: "README.md" },
    ],
  });
  assert.equal(tracksPath("src/extension.ts", configuration), true);
  assert.equal(tracksPath("README.md", configuration), true);
  assert.equal(tracksPath("scripts/build.ts", configuration), false);
  assert.equal(tracksPath("src-old/index.ts", configuration), false);
  assert.equal(tracksPath("src", configuration), true);
});

test("initialization configuration rejects unsafe or incomplete scopes", () => {
  assert.equal(
    parseInitializationConfiguration({
      schemaVersion: 1,
      state: "initialized",
      targets: [{ kind: "folder", path: "../outside" }],
    }),
    undefined,
  );
  assert.equal(
    parseInitializationConfiguration({ schemaVersion: 1, state: "initialized" }),
    undefined,
  );
  assert.equal(
    parseInitializationConfiguration({ schemaVersion: 2, state: "disabled" }),
    undefined,
  );
});
