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
