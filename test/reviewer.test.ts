import assert from "node:assert/strict";
import test from "node:test";
import type { Reviewer } from "../src/domain.ts";
import {
  ReviewerCache,
  ReviewerResolver,
  type ReviewerCacheStorage,
} from "../src/reviewer.ts";

class MemoryStorage implements ReviewerCacheStorage {
  private readonly values = new Map<string, unknown>();

  public get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.get(key) as T | undefined) ?? defaultValue;
  }

  public update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

test("reviewer resolver caches a Git identity and skips the fallback", async () => {
  const storage = new MemoryStorage();
  const cache = new ReviewerCache(storage);
  const calls: string[] = [];
  const identity: Reviewer = {
    name: "Git Reviewer",
    email: "git@example.test",
  };
  const resolver = new ReviewerResolver(
    {
      reviewer(directory) {
        calls.push(`git:${directory}`);
        return Promise.resolve(identity);
      },
    },
    cache,
  );
  let fallbackCalls = 0;
  const fallback = (): Promise<Reviewer> => {
    fallbackCalls += 1;
    return Promise.resolve({ name: "Prompted Reviewer" });
  };

  assert.deepEqual(
    await resolver.resolve("workspace", "/repo", fallback),
    identity,
  );
  assert.deepEqual(
    await resolver.resolve("workspace", "/repo", fallback),
    identity,
  );
  assert.deepEqual(calls, ["git:/repo"]);
  assert.equal(fallbackCalls, 0);

  const restartedResolver = new ReviewerResolver(
    {
      reviewer() {
        calls.push("unexpected-git-call");
        return Promise.resolve(undefined);
      },
    },
    new ReviewerCache(storage),
  );
  assert.deepEqual(
    await restartedResolver.resolve("workspace", "/repo", fallback),
    identity,
  );
  assert.deepEqual(calls, ["git:/repo"]);
  assert.equal(fallbackCalls, 0);
});

test("reviewer resolver caches a prompted identity after Git has no identity", async () => {
  const cache = new ReviewerCache(new MemoryStorage());
  let gitCalls = 0;
  const resolver = new ReviewerResolver(
    {
      reviewer() {
        gitCalls += 1;
        return Promise.resolve(undefined);
      },
    },
    cache,
  );
  let fallbackCalls = 0;
  const fallback = (): Promise<Reviewer> => {
    fallbackCalls += 1;
    return Promise.resolve({ name: "Prompted Reviewer" });
  };

  assert.deepEqual(
    await resolver.resolve("workspace", "/repo", fallback),
    { name: "Prompted Reviewer" },
  );
  assert.deepEqual(
    await resolver.resolve("workspace", "/repo", fallback),
    { name: "Prompted Reviewer" },
  );
  assert.equal(gitCalls, 1);
  assert.equal(fallbackCalls, 1);
});
