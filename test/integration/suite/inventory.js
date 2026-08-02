const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { gunzip } = require("node:zlib");
const { promisify } = require("node:util");
const vscode = require("vscode");

/*
 * The integration tests must assert the filesystem contract of the extension,
 * rather than only checking that one expected JSON file can be read.  Review
 * metadata is deliberately spread across one JSON file per source and one
 * content-addressed snapshot per baseline, so a test that checks only the
 * source's expected hash can miss a record written under a wrong path, an
 * orphaned snapshot, or a record that was created and removed before the
 * assertion ran.  The helpers in this module keep those checks in one place.
 */

const TRACKER_PARTS = [".vscode", "code-review-tracker"];
const INITIALIZATION_FILE = "initialization.json";
const SNAPSHOTS_DIRECTORY = "snapshots";
const gunzipAsync = promisify(gunzip);

/**
 * Convert a workspace-relative path to the exact POSIX form used by the
 * extension's storage hashes.  Callers should pass a workspace-relative path;
 * accepting a backslash here would make a test accidentally disagree with the
 * extension about the identity of a source on Windows.
 */
function normalizedPath(value) {
  return value.replaceAll("\\", "/");
}

/** Return the SHA-256 path identity used by metadata and snapshot filenames. */
function pathHash(relativePath) {
  return createHash("sha256").update(normalizedPath(relativePath)).digest("hex");
}

/** Return the tracker directory for a workspace folder. */
function trackerUri(folder) {
  return vscode.Uri.joinPath(folder.uri, ...TRACKER_PARTS);
}

/** Return the metadata URI for one workspace-relative source path. */
function metadataUri(folder, relativePath) {
  return vscode.Uri.joinPath(
    trackerUri(folder),
    `${pathHash(relativePath)}.json`,
  );
}

/** Return the initialization configuration URI. */
function initializationUri(folder) {
  return vscode.Uri.joinPath(trackerUri(folder), INITIALIZATION_FILE);
}

/** Return the snapshot directory URI. */
function snapshotsUri(folder) {
  return vscode.Uri.joinPath(trackerUri(folder), SNAPSHOTS_DIRECTORY);
}

/**
 * VS Code uses a FileSystemError with the exact code `FileNotFound` for a
 * missing URI.  Tests for absence must check that exact code: treating every
 * filesystem error as "missing" makes permission, malformed-provider, and
 * transient I/O failures look like a successful ignore decision.
 */
function isFileNotFound(error) {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}

/** Read a directory, treating only a genuinely missing directory as empty. */
async function readDirectoryOrEmpty(uri) {
  try {
    return await vscode.workspace.fs.readDirectory(uri);
  } catch (error) {
    if (isFileNotFound(error)) {
      return [];
    }
    throw error;
  }
}

/**
 * Read and parse every persisted review file and snapshot in the tracker
 * directory.  Invalid JSON is intentionally allowed to throw; a malformed
 * metadata file is an extension failure and must never be silently ignored by
 * a test helper.
 *
 * `metadata` contains `{ name, uri, value }` entries for every JSON metadata
 * file.  `recordsByPath` is an index by the path stored inside each JSON file,
 * while `metadataByName` indexes the actual filename.  Keeping both indexes is
 * important: it detects both a wrong hash filename and a wrong stored path.
 * Snapshot entries contain `{ name, uri }`; their bytes are read lazily by
 * `readSnapshot` so a full inventory remains cheap for large workspaces.
 */
async function readInventory(folder) {
  const root = trackerUri(folder);
  const entries = await readDirectoryOrEmpty(root);
  const metadata = [];
  const metadataByName = new Map();
  const recordsByPath = new Map();
  const snapshots = [];
  const temporaryEntries = [];
  const temporarySnapshotEntries = [];
  const unknownEntries = [];

  let initialization;
  try {
    const bytes = await vscode.workspace.fs.readFile(initializationUri(folder));
    initialization = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }
  }

  for (const [name, type] of entries) {
    if (name === INITIALIZATION_FILE) {
      continue;
    }
    if (name === SNAPSHOTS_DIRECTORY) {
      if ((type & vscode.FileType.Directory) === 0) {
        unknownEntries.push(name);
        continue;
      }
      const snapshotEntries = await readDirectoryOrEmpty(snapshotsUri(folder));
      for (const [snapshotName, snapshotType] of snapshotEntries) {
        const snapshotUri = vscode.Uri.joinPath(
          snapshotsUri(folder),
          snapshotName,
        );
        if ((snapshotType & vscode.FileType.File) !== 0) {
          if (snapshotName.includes(".tmp-")) {
            temporarySnapshotEntries.push(snapshotName);
          } else if (!snapshotName.endsWith(".gz")) {
            unknownEntries.push(`${SNAPSHOTS_DIRECTORY}/${snapshotName}`);
          } else {
            snapshots.push({ name: snapshotName, uri: snapshotUri });
          }
        } else {
          unknownEntries.push(`${SNAPSHOTS_DIRECTORY}/${snapshotName}`);
        }
      }
      continue;
    }
    if ((type & vscode.FileType.File) === 0) {
      unknownEntries.push(name);
      continue;
    }
    if (name.includes(".tmp-")) {
      temporaryEntries.push(name);
      continue;
    }
    if (!name.endsWith(".json")) {
      unknownEntries.push(name);
      continue;
    }

    const uri = vscode.Uri.joinPath(root, name);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const value = JSON.parse(new TextDecoder().decode(bytes));
    assert.equal(
      value?.schemaVersion,
      4,
      `Metadata file ${name} does not contain a v4 record`,
    );
    assert.equal(
      typeof value?.path,
      "string",
      `Metadata file ${name} does not identify a source path`,
    );
    assert.ok(value.file && typeof value.file === "object", `Metadata file ${name} has no file record`);
    const path = normalizedPath(value.path);
    assert.equal(
      value.path,
      path,
      `Metadata file ${name} stores a non-normalized source path`,
    );
    assert.equal(
      name,
      `${pathHash(path)}.json`,
      `Metadata file ${name} is not named for its stored source path`,
    );
    assert.equal(
      typeof value.file.baseline?.digest,
      "string",
      `Metadata file ${name} has no baseline digest`,
    );
    assert.match(
      value.file.baseline.digest,
      /^[0-9a-f]{64}$/,
      `Metadata file ${name} has an invalid baseline digest`,
    );
    assert.equal(
      value.file.baseline.codec,
      "gzip",
      `Metadata file ${name} does not use gzip snapshots`,
    );
    assert.equal(
      value.file.baseline.file,
      `${pathHash(path)}.${value.file.baseline.digest}.gz`,
      `Metadata file ${name} references a snapshot for another source`,
    );
    assert.equal(
      Number.isInteger(value.file.baseline.size) && value.file.baseline.size >= 0,
      true,
      `Metadata file ${name} has an invalid baseline size`,
    );
    assert.match(
      value.file.current?.digest ?? "",
      /^[0-9a-f]{64}$/,
      `Metadata file ${name} has an invalid current digest`,
    );
    assert.equal(
      Number.isInteger(value.file.current?.size) && value.file.current.size >= 0,
      true,
      `Metadata file ${name} has an invalid current size`,
    );
    assert.equal(
      value.file.current?.gitAlgorithm,
      "myers",
      `Metadata file ${name} does not record the required Git diff algorithm`,
    );
    assert.ok(
      ["pending", "inReview", "reviewed"].includes(value.file.fileStatus),
      `Metadata file ${name} has an invalid review status`,
    );
    const entry = { name, uri, value };
    metadata.push(entry);
    metadataByName.set(name, entry);
    if (typeof value.path === "string") {
      const existing = recordsByPath.get(path) ?? [];
      assert.equal(
        existing.length,
        0,
        `Multiple metadata records are persisted for ${path}`,
      );
      existing.push(entry);
      recordsByPath.set(path, existing);
    }
  }

  const referencedSnapshots = new Set(
    metadata.map((entry) => entry.value.file.baseline.file),
  );
  const snapshotNames = new Set(snapshots.map((entry) => entry.name));
  const orphanSnapshots = snapshots
    .filter((entry) => !referencedSnapshots.has(entry.name))
    .map((entry) => entry.name);
  const missingSnapshots = [...referencedSnapshots].filter(
    (name) => !snapshotNames.has(name),
  );

  return {
    root,
    initialization,
    metadata,
    metadataByName,
    recordsByPath,
    snapshots,
    snapshotNames,
    orphanSnapshots,
    missingSnapshots,
    temporaryEntries,
    temporarySnapshotEntries,
    unknownEntries,
  };
}

/** Read one snapshot's exact compressed bytes. */
async function readSnapshot(folder, name) {
  return vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(snapshotsUri(folder), name),
  );
}

/** Assert that an URI fails specifically because it does not exist. */
async function assertFileNotFound(uri, description = uri.toString()) {
  await assert.rejects(
    vscode.workspace.fs.stat(uri),
    (error) => {
      assert.ok(
        isFileNotFound(error),
        `${description} failed with an unexpected filesystem error: ${String(error)}`,
      );
      return true;
    },
  );
}

/**
 * Assert that a metadata file exists under its expected hash and contains the
 * requested path.  The optional digest check ties metadata to the actual saved
 * file, preventing a stale or cross-path record from satisfying the test.
 */
async function assertMetadataPresent(folder, relativePath, options = {}) {
  const path = normalizedPath(relativePath);
  const inventory = await readInventory(folder);
  const expectedName = `${pathHash(path)}.json`;
  const expected = inventory.metadataByName.get(expectedName);
  assert.ok(expected, `Missing review metadata for ${path}`);
  assert.equal(
    expected.value.path,
    path,
    `Metadata filename ${expectedName} stores a different source path`,
  );
  const records = inventory.recordsByPath.get(path) ?? [];
  assert.equal(records.length, 1, `Expected exactly one metadata record for ${path}`);
  assert.ok(expected.value.file, `Metadata for ${path} has no file record`);
  assert.equal(expected.value.file.current?.size >= 0, true);

  if (options.verifyCurrentDigest !== false) {
    const sourceUri = vscode.Uri.joinPath(folder.uri, ...path.split("/"));
    const sourceBytes = await vscode.workspace.fs.readFile(sourceUri);
    const digest = createHash("sha256").update(sourceBytes).digest("hex");
    assert.equal(
      expected.value.file.current?.digest,
      digest,
      `Metadata for ${path} does not describe the current saved bytes`,
    );
    assert.equal(
      expected.value.file.current?.size,
      sourceBytes.byteLength,
      `Metadata for ${path} has an incorrect current byte size`,
    );
  }

  if (options.requireSnapshot !== false) {
    const snapshotName = expected.value.file.baseline?.file;
    const baseline = expected.value.file.baseline;
    assert.equal(
      typeof snapshotName,
      "string",
      `Metadata for ${path} has no baseline snapshot filename`,
    );
    assert.equal(baseline?.codec, "gzip");
    assert.equal(
      snapshotName,
      `${pathHash(path)}.${baseline?.digest}.gz`,
      `Metadata for ${path} has a snapshot identity unrelated to its path`,
    );
    assert.ok(
      inventory.snapshotNames.has(snapshotName),
      `Metadata for ${path} references missing snapshot ${snapshotName}`,
    );
    const compressed = await readSnapshot(folder, snapshotName);
    const baselineBytes = await gunzipAsync(compressed);
    assert.equal(
      baselineBytes.byteLength,
      baseline?.size,
      `Baseline snapshot for ${path} has an incorrect byte size`,
    );
    assert.equal(
      createHash("sha256").update(baselineBytes).digest("hex"),
      baseline?.digest,
      `Baseline snapshot for ${path} has an incorrect digest`,
    );
  }
  if (options.status !== undefined) {
    assert.equal(expected.value.file.fileStatus, options.status);
  }
  return expected.value;
}

/** Assert that the tracker contains exactly the expected source-path set. */
async function assertMetadataPaths(folder, expected, context = "") {
  const inventory = await readInventory(folder);
  const actual = [...inventory.recordsByPath.keys()].sort();
  const expectedPaths = [
    ...new Set([...expected].map(normalizedPath)),
  ].sort();
  assert.deepEqual(
    actual,
    expectedPaths,
    `${context} metadata path inventory differs from the eligible source set`,
  );
}

/** Assert that neither metadata nor any path-owned baseline snapshot exists. */
async function assertMetadataMissing(folder, relativePath, context = "") {
  const path = normalizedPath(relativePath);
  const inventory = await readInventory(folder);
  const expectedName = `${pathHash(path)}.json`;
  assert.equal(
    inventory.metadataByName.has(expectedName),
    false,
    `${context} unexpected metadata file ${expectedName} for ${path}`,
  );
  assert.equal(
    inventory.recordsByPath.has(path),
    false,
    `${context} metadata inventory still contains ${path}`,
  );
  assert.equal(
    inventory.snapshots.some((entry) =>
      entry.name.startsWith(`${pathHash(path)}.`),
    ),
    false,
    `${context} snapshot inventory still contains a baseline for ${path}`,
  );
  await assertFileNotFound(
    metadataUri(folder, path),
    `${context} metadata for ${path}`,
  );
}

/** Assert that a named snapshot exists as a regular file. */
async function assertSnapshotPresent(folder, name, context = "") {
  const inventory = await readInventory(folder);
  assert.ok(
    inventory.snapshotNames.has(name),
    `${context} missing snapshot ${name}`,
  );
  const stat = await vscode.workspace.fs.stat(
    vscode.Uri.joinPath(snapshotsUri(folder), name),
  );
  assert.ok(
    (stat.type & vscode.FileType.File) !== 0,
    `${context} snapshot ${name} is not a regular file`,
  );
  return readSnapshot(folder, name);
}

/** Assert that a named snapshot does not exist, requiring exact FileNotFound. */
async function assertSnapshotMissing(folder, name, context = "") {
  const inventory = await readInventory(folder);
  assert.equal(
    inventory.snapshotNames.has(name),
    false,
    `${context} unexpected snapshot ${name}`,
  );
  await assertFileNotFound(
    vscode.Uri.joinPath(snapshotsUri(folder), name),
    `${context} snapshot ${name}`,
  );
}

/**
 * Assert that initialization did not add an exact explicit target for a path.
 * A root folder target (`{ kind: 'folder', path: '' }`) is intentionally not
 * rejected: it describes the configured scope, while Git-ignore eligibility
 * still has to prevent a per-file metadata write.  The helper catches the
 * accidental file-target expansion that previously made ignored files appear
 * tracked after discovery.
 */
async function assertNoExplicitTarget(folder, relativePath, context = "") {
  const path = normalizedPath(relativePath);
  const inventory = await readInventory(folder);
  const targets = inventory.initialization?.targets ?? [];
  assert.equal(
    targets.some(
      (target) =>
        (target.kind === "file" || target.kind === "folder") &&
        normalizedPath(target.path) === path,
    ),
    false,
    `${context} initialization explicitly targets ignored path ${path}`,
  );
}

/**
 * A completed operation must not leave atomic-write temporary files or
 * unexpected entries in the tracker directory. Leaving either behind can
 * make a later restart appear healthy while the previous commit was only
 * partially persisted.
 */
async function assertNoUnknownTrackerEntries(folder, context = "") {
  const inventory = await readInventory(folder);
  assert.deepEqual(
    inventory.temporaryEntries,
    [],
    `${context} temporary metadata writes remain on disk`,
  );
  assert.deepEqual(
    inventory.temporarySnapshotEntries,
    [],
    `${context} temporary snapshot writes remain on disk`,
  );
  assert.deepEqual(
    inventory.unknownEntries,
    [],
    `${context} unexpected tracker entries remain on disk`,
  );
  assert.deepEqual(
    inventory.orphanSnapshots,
    [],
    `${context} unreferenced baseline snapshots remain on disk`,
  );
  assert.deepEqual(
    inventory.missingSnapshots,
    [],
    `${context} metadata references missing baseline snapshots`,
  );
  for (const entry of inventory.metadata) {
    const baseline = entry.value.file.baseline;
    const bytes = await gunzipAsync(
      await readSnapshot(folder, baseline.file),
    );
    assert.equal(
      bytes.byteLength,
      baseline.size,
      `${context} baseline snapshot ${baseline.file} has an incorrect size`,
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      baseline.digest,
      `${context} baseline snapshot ${baseline.file} has an incorrect digest`,
    );
  }
}

/**
 * Repeatedly run an assertion/predicate until it succeeds or the deadline is
 * reached.  Returning `false` means "not ready yet"; any other return value
 * (including `undefined`, which assertion functions normally return) succeeds.
 * Assertion errors are retained and included in the timeout message so a
 * failure explains what remained missing or incorrect.
 */
async function waitUntil(description, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result !== false) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const suffix = lastError === undefined ? "" : `: ${String(lastError)}`;
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

/** Wait until one path has valid metadata and a referenced snapshot. */
function waitForMetadata(folder, relativePath, options = {}) {
  const path = normalizedPath(relativePath);
  return waitUntil(
    `review metadata for ${path}`,
    () => assertMetadataPresent(folder, path, options),
    options,
  );
}

/** Wait until one path's metadata file is absent with an exact error code. */
function waitForMetadataMissing(folder, relativePath, options = {}) {
  const path = normalizedPath(relativePath);
  return waitUntil(
    `review metadata to disappear for ${path}`,
    async () => assertMetadataMissing(folder, path),
    options,
  );
}

/**
 * Keep checking a forbidden path for a settling window.  This is stronger
 * than a single stat immediately after a file event, while the event watcher
 * below catches a metadata create/rename that is later cleaned up.
 */
async function assertAbsentDuring(
  folder,
  paths,
  options = {},
) {
  const normalizedPaths = paths.map(normalizedPath);
  const durationMs = options.durationMs ?? 750;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    for (const path of normalizedPaths) {
      await assertMetadataMissing(folder, path, options.context ?? "");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Observe tracker-directory filesystem events for a set of forbidden paths.
 * Metadata and snapshots are written through temporary files followed by an
 * atomic rename, so both final names and extension temporary names are
 * recognized.  Deletes are retained in `events` for diagnostics but do not
 * count as forbidden writes; cleanup of a pre-existing record is expected when
 * a path becomes ignored.  Call `assertNoForbiddenEvents()` after each
 * operation and `dispose()` in a `finally` block.
 *
 * This VS Code watcher observes events after the extension host is running. A
 * parent test runner that needs to detect startup writes before the suite is
 * loaded should additionally use a host-level filesystem watcher; the final
 * inventory assertions remain mandatory either way.
 */
function watchForbiddenPaths(folder, paths) {
  const forbidden = new Set(paths.map((path) => pathHash(normalizedPath(path))));
  const events = [];
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, ".vscode/code-review-tracker/**"),
    false,
    false,
    false,
  );

  const inspect = (kind, uri) => {
    const relative = normalizedPath(vscode.workspace.asRelativePath(uri, false));
    const name = relative.slice(".vscode/code-review-tracker/".length);
    const isForbiddenMetadata = [...forbidden].some(
      (hash) =>
        name === `${hash}.json` || name.startsWith(`.${hash}.json.tmp-`),
    );
    const isForbiddenSnapshot = [...forbidden].some(
      (hash) => name.startsWith(`snapshots/${hash}.`),
    );
    if (isForbiddenMetadata || isForbiddenSnapshot) {
      events.push({ kind, uri, relative });
    }
  };

  const subscriptions = [
    watcher,
    watcher.onDidCreate((uri) => inspect("create", uri)),
    watcher.onDidChange((uri) => inspect("change", uri)),
    watcher.onDidDelete((uri) => inspect("delete", uri)),
  ];
  const writes = () => events.filter((event) => event.kind !== "delete");

  return {
    events,
    /** Add a path before its create/open/interaction operation begins. */
    addPath(path) {
      forbidden.add(pathHash(normalizedPath(path)));
    },
    /** Stop treating a path as forbidden after a test deliberately makes it eligible. */
    removePath(path) {
      forbidden.delete(pathHash(normalizedPath(path)));
    },
    /** Return only writes; cleanup deletes are useful diagnostics but allowed. */
    writes,
    assertNoForbiddenEvents(context = "") {
      assert.deepEqual(
        writes(),
        [],
        `${context} ignored-path metadata/snapshot writes observed: ${JSON.stringify(writes())}`,
      );
    },
    dispose() {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    },
  };
}

module.exports = {
  pathHash,
  trackerUri,
  metadataUri,
  initializationUri,
  snapshotsUri,
  isFileNotFound,
  readInventory,
  readSnapshot,
  assertFileNotFound,
  assertMetadataPresent,
  assertMetadataPaths,
  assertMetadataMissing,
  assertSnapshotPresent,
  assertSnapshotMissing,
  assertNoExplicitTarget,
  assertNoUnknownTrackerEntries,
  waitUntil,
  waitForMetadata,
  waitForMetadataMissing,
  assertAbsentDuring,
  watchForbiddenPaths,
};
