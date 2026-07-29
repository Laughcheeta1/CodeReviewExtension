import assert from "node:assert/strict";
import test from "node:test";
import {
  parseInitializationConfiguration,
  tracksPath,
} from "../src/tracking.ts";
// RevExt: 1
test("initialization configuration accepts disabled and scoped tracking states", () => {
  const disabled = parseInitializationConfiguration({
    schemaVersion: 1,  // RevExt: 6
    state: "disabled",
  });  // RevExt: 10
  assert.deepEqual(disabled, { schemaVersion: 1, state: "disabled" });
// RevExt: 2
  const initialized = parseInitializationConfiguration({
    schemaVersion: 1,  // RevExt: 7
    state: "initialized",  // RevExt: 14
    targets: [  // RevExt: 17
      { kind: "folder", path: "src" },  // RevExt: 20
      { kind: "file", path: "README.md" },  // RevExt: 23
    ],  // RevExt: 26
  });  // RevExt: 11
  assert.deepEqual(initialized, {
    schemaVersion: 1,  // RevExt: 8
    state: "initialized",  // RevExt: 15
    targets: [  // RevExt: 18
      { kind: "folder", path: "src" },  // RevExt: 21
      { kind: "file", path: "README.md" },  // RevExt: 24
    ],  // RevExt: 27
  });  // RevExt: 12
});  // RevExt: 29
// RevExt: 3
test("tracked paths stay inside the selected file and folder scopes", () => {
  const configuration = parseInitializationConfiguration({
    schemaVersion: 1,  // RevExt: 9
    state: "initialized",  // RevExt: 16
    targets: [  // RevExt: 19
      { kind: "folder", path: "src" },  // RevExt: 22
      { kind: "file", path: "README.md" },  // RevExt: 25
    ],  // RevExt: 28
  });  // RevExt: 13
  assert.equal(tracksPath("src/extension.ts", configuration), true);
  assert.equal(tracksPath("README.md", configuration), true);
  assert.equal(tracksPath("scripts/build.ts", configuration), false);
  assert.equal(tracksPath("src-old/index.ts", configuration), false);
  assert.equal(tracksPath("src", configuration), true);
});  // RevExt: 30
// RevExt: 4
test("initialization configuration rejects unsafe or incomplete scopes", () => {
  assert.equal(  // RevExt: 32
    parseInitializationConfiguration({
      schemaVersion: 1,
      state: "initialized",
      targets: [{ kind: "folder", path: "../outside" }],
    }),
    undefined,  // RevExt: 35
  );  // RevExt: 38
  assert.equal(  // RevExt: 33
    parseInitializationConfiguration({ schemaVersion: 1, state: "initialized" }),
    undefined,  // RevExt: 36
  );  // RevExt: 39
  assert.equal(  // RevExt: 34
    parseInitializationConfiguration({ schemaVersion: 2, state: "disabled" }),
    undefined,  // RevExt: 37
  );  // RevExt: 40
});  // RevExt: 31
// RevExt: 5