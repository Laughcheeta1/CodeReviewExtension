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

  public seed(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}

test("the cache ignores malformed stored values", () => {
  const storage = new MemoryStorage();
  const cache = new ReviewerCache(storage);
  for (const corrupt of ["nope", 42, [], [{ name: "R" }]]) {
    storage.seed("reviewerCache", corrupt);
    assert.equal(cache.get("workspace"), undefined);
  }
  storage.seed("reviewerCache", {
    workspace: { name: "   " },
    other: { name: 42 },
    third: { name: "R", email: 7 },
  });
  assert.equal(cache.get("workspace"), undefined);
  assert.equal(cache.get("other"), undefined);
  assert.equal(cache.get("third"), undefined);
  assert.equal(cache.get("missing"), undefined);
});

test("the cache trims names and accepts an absent email", async () => {
  const storage = new MemoryStorage();
  const cache = new ReviewerCache(storage);
  await cache.set("workspace", { name: "  Cached  ", email: "" });
  assert.deepEqual(cache.get("workspace"), { name: "Cached" });
  await cache.set("workspace", { name: "Cached", email: "  c@x.test  " });
  assert.deepEqual(cache.get("workspace"), {
    name: "Cached",
    email: "c@x.test",
  });
});

test("the resolver retries the fallback when nobody resolves", async () => {
  const resolver = new ReviewerResolver(
    { reviewer: () => Promise.resolve(undefined) },
    new ReviewerCache(new MemoryStorage()),
  );
  let fallbackCalls = 0;
  const fallback = (): Promise<Reviewer | undefined> => {
    fallbackCalls += 1;
    return Promise.resolve(undefined);
  };
  assert.equal(await resolver.resolve("workspace", "/repo", fallback), undefined);
  assert.equal(await resolver.resolve("workspace", "/repo", fallback), undefined);
  assert.equal(fallbackCalls, 2);
});

test("the resolver shares one identity across concurrent callers", async () => {
  let gitCalls = 0;
  const resolver = new ReviewerResolver(
    {
      reviewer: () => {
        gitCalls += 1;
        return new Promise<Reviewer>((resolve) => {
          setTimeout(() => resolve({ name: "R" }), 10);
        });
      },
    },
    new ReviewerCache(new MemoryStorage()),
  );
  const fallback = (): Promise<Reviewer | undefined> =>
    Promise.resolve({ name: "Fallback" });
  const [first, second] = await Promise.all([
    resolver.resolve("workspace", "/repo", fallback),
    resolver.resolve("workspace", "/repo", fallback),
  ]);
  assert.deepEqual(first, { name: "R" });
  assert.deepEqual(second, { name: "R" });
  assert.equal(gitCalls, 1);
});
