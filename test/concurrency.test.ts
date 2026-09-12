import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { forEachConcurrent, mapConcurrent } from "../src/concurrency.ts";

function barrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("failed concurrent batches drain active effects before rejecting and stop new work", async () => {
  const failure = new Error("first operation failed");
  const fail = barrier();
  const finish = barrier();
  const started: number[] = [];
  const effects: number[] = [];
  let settled = false;
  const batch = forEachConcurrent([0, 1, 2, 3], 2, async (item) => {
    started.push(item);
    if (item === 0) {
      await fail.promise;
      throw failure;
    }
    await finish.promise;
    effects.push(item);
  });
  const observed = batch.then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    assert.deepEqual(started, [0, 1]);
    fail.release();
    await setImmediate();
    assert.equal(settled, false, "batch must remain pending until active work finishes");
    assert.deepEqual(effects, []);
  } finally {
    finish.release();
  }
  assert.equal(await observed, failure);
  assert.deepEqual(started, [0, 1], "queued operations must not begin after failure");
  assert.deepEqual(effects, [1], "active side effects must finish before caller cleanup");
});

test("concurrent mapping honors its limit and preserves input order", async () => {
  const gates = Array.from({ length: 4 }, barrier);
  const started: number[] = [];
  let active = 0;
  let maximum = 0;
  const mapped = mapConcurrent([0, 1, 2, 3], 2, async (item) => {
    started.push(item);
    active += 1;
    maximum = Math.max(maximum, active);
    await gates[item]!.promise;
    active -= 1;
    return item * 10;
  });
  try {
    assert.deepEqual(started, [0, 1]);
    gates[1]!.release();
    await setImmediate();
    assert.deepEqual(started, [0, 1, 2]);
    gates[2]!.release();
    await setImmediate();
    assert.deepEqual(started, [0, 1, 2, 3]);
  } finally {
    for (const gate of gates) {
      gate.release();
    }
  }
  assert.deepEqual(await mapped, [0, 10, 20, 30]);
  assert.equal(maximum, 2);
});

test("empty batches invoke no operations", async () => {
  assert.deepEqual(await mapConcurrent([], 2, () =>
    Promise.reject(new Error("empty batches must not invoke the callback")),
  ), []);
});

test("draining preserves the first rejection even when it is undefined", async () => {
  const second = barrier();
  const batch = forEachConcurrent([0, 1, 2], 2, async (item) => {
    if (item === 0) {
      // Exercise third-party callbacks that reject without an Error object.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw undefined;
    }
    await second.promise;
    throw new Error("later failure");
  });
  const observed = batch.then(
    () => assert.fail("batch must reject"),
    (error: unknown) => assert.equal(error, undefined),
  );
  await setImmediate();
  second.release();
  await observed;
});
