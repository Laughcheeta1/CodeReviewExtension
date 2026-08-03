import type { Reviewer } from "./domain";

const REVIEWER_CACHE_KEY = "reviewerCache";

export interface ReviewerIdentitySource {
  reviewer(directory: string | undefined): Promise<Reviewer | undefined>;
}

export interface ReviewerCacheStorage {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export class ReviewerCache {
  private updateTail: Promise<void> = Promise.resolve();

  constructor(private readonly storage: ReviewerCacheStorage) {}

  public get(workspaceKey: string): Reviewer | undefined {
    const entries = this.storage.get<unknown>(REVIEWER_CACHE_KEY);
    if (!isRecord(entries)) {
      return undefined;
    }
    return parseReviewer(entries[workspaceKey]);
  }

  public async set(workspaceKey: string, reviewer: Reviewer): Promise<void> {
    const update = this.updateTail.then(async () => {
      const entries = this.storage.get<unknown>(REVIEWER_CACHE_KEY);
      const current = isRecord(entries) ? entries : {};
      await this.storage.update(REVIEWER_CACHE_KEY, {
        ...current,
        [workspaceKey]: reviewer,
      });
    });
    this.updateTail = update.catch(() => undefined);
    await update;
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
    const active = this.resolutions.get(workspaceKey);
    if (active !== undefined) {
      return active;
    }
    const current = this.resolveUncached(workspaceKey, directory, fallback);
    this.resolutions.set(workspaceKey, current);
    void current.then(
      () => this.clearResolution(workspaceKey, current),
      () => this.clearResolution(workspaceKey, current),
    );
    return current;
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

  private clearResolution(
    workspaceKey: string,
    resolution: Promise<Reviewer | undefined>,
  ): void {
    if (this.resolutions.get(workspaceKey) === resolution) {
      this.resolutions.delete(workspaceKey);
    }
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
