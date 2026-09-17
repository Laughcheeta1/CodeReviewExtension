import ignore, { type Ignore } from "ignore";

/** A .gitignore file and the workspace-relative directory it belongs to. */
export interface IgnoreFile {
  readonly directory: string;
  readonly contents: string;
}

interface IgnoreScope {
  readonly directory: string;
  readonly matcher: Ignore;
}

/** Apply root and nested .gitignore contents to workspace-relative paths. */
export function ignoredPathsFromFiles(
  paths: readonly string[],
  files: readonly IgnoreFile[],
): ReadonlySet<string> {
  return ignoredPathsFromMatcher(paths, createWorkspaceIgnoreMatcher(files));
}

/** Compile workspace ignore rules once so repeated path checks stay cheap. */
export function createWorkspaceIgnoreMatcher(
  files: readonly IgnoreFile[],
): WorkspaceIgnoreMatcher {
  const scopes = files
    .map((file) => ({
      directory: normalizePath(file.directory),
      matcher: createMatcher(file.contents),
    }))
    .sort((left, right) => {
      const depthDifference = pathDepth(left.directory) - pathDepth(right.directory);
      return depthDifference || left.directory.localeCompare(right.directory);
    });
  const scopesByDirectory = new Map<string, Ignore[]>();
  for (const scope of scopes) {
    const existing = scopesByDirectory.get(scope.directory);
    if (existing === undefined) {
      scopesByDirectory.set(scope.directory, [scope.matcher]);
    } else {
      existing.push(scope.matcher);
    }
  }
  return new WorkspaceIgnoreMatcher(scopes, scopesByDirectory);
}

/** Apply a previously compiled matcher to workspace-relative paths. */
export function ignoredPathsFromMatcher(
  paths: readonly string[],
  matcher: WorkspaceIgnoreMatcher,
): ReadonlySet<string> {
  const ignored = new Set<string>();
  for (const path of paths) {
    const normalized = normalizePath(path);
    if (normalized.length > 0 && matcher.ignores(normalized)) {
      ignored.add(path);
    }
  }
  return ignored;
}

export class WorkspaceIgnoreMatcher {
  private readonly states = new Map<string, boolean>();

  constructor(
    private readonly scopes: readonly IgnoreScope[],
    private readonly scopesByDirectory: ReadonlyMap<string, readonly Ignore[]> = (() => {
      const map = new Map<string, Ignore[]>();
      for (const scope of scopes) {
        const existing = map.get(scope.directory);
        if (existing === undefined) {
          map.set(scope.directory, [scope.matcher]);
        } else {
          existing.push(scope.matcher);
        }
      }
      return map;
    })(),
  ) {}

  public ignores(path: string): boolean {
    return this.stateForFile(path);
  }

  private stateForFile(path: string): boolean {
    const key = `file:${path}`;
    const cached = this.states.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const parent = parentPath(path);
    if (parent !== undefined && this.stateForDirectory(parent)) {
      this.states.set(key, true);
      return true;
    }
    const state = this.directState(path);
    this.states.set(key, state);
    return state;
  }

  private stateForDirectory(path: string): boolean {
    const key = `directory:${path}`;
    const cached = this.states.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const parent = parentPath(path);
    if (parent !== undefined && this.stateForDirectory(parent)) {
      this.states.set(key, true);
      return true;
    }
    const state = this.directState(`${path}/`);
    this.states.set(key, state);
    return state;
  }

  /** Apply each directory's rules from the workspace root downward. */
  private directState(path: string): boolean {
    let state = false;
    const ancestors = ancestorDirectories(path);
    for (const ancestor of ancestors) {
      const matchers = this.scopesByDirectory.get(ancestor);
      if (matchers === undefined) {
        continue;
      }
      const relative = relativeToScope(path, ancestor);
      if (relative === undefined || relative.length === 0) {
        continue;
      }
      for (const matcher of matchers) {
        const result = matcher.test(relative);
        if (result.ignored) {
          state = true;
        } else if (result.unignored) {
          state = false;
        }
      }
    }
    return state;
  }
}

function createMatcher(contents: string): Ignore {
  // Git ignore matching is case-sensitive by default on Linux/macOS unless
  // repository configuration changes it. We deliberately do not consult
  // that configuration, so use a deterministic case-sensitive matcher.
  return ignore({ ignorecase: false }).add(contents);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function pathDepth(path: string): number {
  return path.length === 0 ? 0 : path.split("/").length;
}

function parentPath(path: string): string | undefined {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? undefined : path.slice(0, separator);
}

function ancestorDirectories(path: string): readonly string[] {
  const isDirectory = path.endsWith("/");
  const normalized = isDirectory ? path.slice(0, -1) : path;
  const ancestors: string[] = [""];
  if (normalized.length === 0) {
    return ancestors;
  }
  const directoryPart = isDirectory ? normalized : (parentPath(normalized) ?? "");
  if (directoryPart.length === 0) {
    return ancestors;
  }
  const parts = directoryPart.split("/");
  let prefix = "";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || part.length === 0) {
      continue;
    }
    prefix = prefix.length === 0 ? part : `${prefix}/${part}`;
    ancestors.push(prefix);
  }
  return ancestors;
}

function relativeToScope(path: string, scope: string): string | undefined {
  if (scope.length === 0) {
    return path;
  }
  const prefix = `${scope}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}
