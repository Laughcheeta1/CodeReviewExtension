import type { Reviewer } from "./domain";
import { coalesced, serialized } from "./concurrency";

const REVIEWER_CACHE_KEY = "reviewerCache";
const SINGLETON_KEY = "reviewer-cache-writes";

export interface ReviewerIdentitySource {
  reviewer(directory: string | undefined): Promise<Reviewer | undefined>;
}

export interface ReviewerCacheStorage {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export class ReviewerCache {
  private readonly updateTails = new Map<string, Promise<unknown>>();

  constructor(private readonly storage: ReviewerCacheStorage) {}

  public get(workspaceKey: string): Reviewer | undefined {
    const entries = this.storage.get<unknown>(REVIEWER_CACHE_KEY);
    if (!isRecord(entries)) {
      return undefined;
    }
    return parseReviewer(entries[workspaceKey]);
  }

  public async set(workspaceKey: string, reviewer: Reviewer): Promise<void> {
    // All writes share one key because every update read-modify-writes the
    // same stored object; per-key serialization could lose a concurrent key.
    await serialized(this.updateTails, SINGLETON_KEY, async () => {
      const entries = this.storage.get<unknown>(REVIEWER_CACHE_KEY);
      const current = isRecord(entries) ? entries : {};
      await this.storage.update(REVIEWER_CACHE_KEY, {
        ...current,
        [workspaceKey]: reviewer,
      });
    });
  }
}

export class ReviewerResolver {
  private readonly resolutions = new Map<
    string,
    Promise<Reviewer | undefined>
  >();

  constructor(
    private readonly identitySource: ReviewerIdentitySource,
    private readonly cache: ReviewerCache,
  ) {}

  public async resolve(
    workspaceKey: string,
    directory: string | undefined,
    fallback: () => Promise<Reviewer | undefined>,
  ): Promise<Reviewer | undefined> {
    return coalesced(this.resolutions, workspaceKey, () =>
      this.resolveUncached(workspaceKey, directory, fallback),
    );
  }

  private async resolveUncached(
    workspaceKey: string,
    directory: string | undefined,
    fallback: () => Promise<Reviewer | undefined>,
  ): Promise<Reviewer | undefined> {
    const cached = this.cache.get(workspaceKey);
    if (cached !== undefined) {
      return cached;
    }

    const fromGit = await this.identitySource.reviewer(directory);
    if (fromGit !== undefined) {
      await this.cache.set(workspaceKey, fromGit);
      return fromGit;
    }

    const fromFallback = await fallback();
    if (fromFallback !== undefined) {
      await this.cache.set(workspaceKey, fromFallback);
    }
    return fromFallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReviewer(value: unknown): Reviewer | undefined {
  if (!isRecord(value) || typeof value.name !== "string") {
    return undefined;
  }
  const name = value.name.trim();
  if (name.length === 0) {
    return undefined;
  }
  if (value.email === undefined) {
    return { name };
  }
  if (typeof value.email !== "string") {
    return undefined;
  }
  const email = value.email.trim();
  return email.length === 0 ? { name } : { name, email };
}
