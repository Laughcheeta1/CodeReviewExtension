/**
 * Shared per-key async coordination primitives.
 *
 * Several services serialize or coalesce concurrent work keyed by a string
 * (per-source operation queues, load caches, eligibility refreshes). These
 * helpers own the tail-map bookkeeping so each call site states only its
 * key and its operation.
 */

/**
 * Share one in-flight promise between concurrent callers of the same key.
 * The tail entry is removed once the operation settles, so later callers
 * start fresh work. Rejections propagate to every coalesced caller.
 */
export async function coalesced<T>(
  tails: Map<string, Promise<T>>,
  key: string,
  create: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key);
  if (previous !== undefined) {
    return previous;
  }
  const current = create();
  tails.set(key, current);
  try {
    return await current;
  } finally {
    if (tails.get(key) === current) {
      tails.delete(key);
    }
  }
}

/**
 * Run operations for the same key one at a time, in call order. The stored
 * tail never rejects, so a failure never blocks later operations; the
 * failure itself still propagates to its own caller.
 */
export async function serialized<T>(
  tails: Map<string, Promise<unknown>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  try {
    return await current;
  } finally {
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  }
}

export const STORE_CONCURRENCY_LIMIT = 16;

/**
 * Run an operation for each item with bounded concurrency. The result order
 * is not preserved; callers that need ordering should handle it themselves.
 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const bounded = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;
  const workers = Array.from({ length: bounded }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      const item = items[index]!;
      await operation(item, index);
    }
  });
  await Promise.all(workers);
}

/**
 * Map items with bounded concurrency, preserving order.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const results = new Array<R>(items.length) as R[];
  await forEachConcurrent(items, limit, async (item, index) => {
    results[index] = await operation(item, index);
  });
  return results;
}
