export interface TrackingTarget {
  readonly kind: "file" | "folder";
  readonly path: string;
}

export interface InitializationConfiguration {
  readonly schemaVersion: 1;
  readonly state: "disabled" | "initialized";
  readonly targets?: readonly TrackingTarget[];
}

export function parseInitializationConfiguration(
  value: unknown,
): InitializationConfiguration | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return undefined;
  }
  if (value.state === "disabled") {
    return { schemaVersion: 1, state: "disabled" };
  }
  if (
    value.state !== "initialized" ||
    !Array.isArray(value.targets) ||
    value.targets.length === 0
  ) {
    return undefined;
  }
  const targets: TrackingTarget[] = [];
  for (const target of value.targets) {
    if (!isTrackingTarget(target)) {
      return undefined;
    }
    targets.push(target);
  }
  return { schemaVersion: 1, state: "initialized", targets };
}

export interface CompiledTrackingMatcher {
  readonly tracksRoot: boolean;
  readonly files: ReadonlySet<string>;
  readonly folders: ReadonlySet<string>;
}

export function compileTrackingMatcher(
  configuration: InitializationConfiguration | undefined,
): CompiledTrackingMatcher {
  if (configuration?.state !== "initialized" || configuration.targets === undefined) {
    return { tracksRoot: false, files: new Set(), folders: new Set() };
  }
  let tracksRoot = false;
  const files = new Set<string>();
  const folders = new Set<string>();
  for (const target of configuration.targets) {
    if (target.kind === "file") {
      files.add(target.path);
    } else if (target.path.length === 0) {
      tracksRoot = true;
    } else {
      folders.add(target.path);
    }
  }
  return { tracksRoot, files, folders };
}

export function tracksPathCompiled(
  path: string,
  matcher: CompiledTrackingMatcher,
): boolean {
  if (matcher.tracksRoot) {
    return true;
  }
  if (matcher.files.has(path)) {
    return true;
  }
  if (matcher.folders.has(path)) {
    return true;
  }
  // Check ancestor folders: path = "a/b/c", ancestors = "a/b", "a"
  let separator = path.lastIndexOf("/");
  while (separator !== -1) {
    const ancestor = path.slice(0, separator);
    if (matcher.folders.has(ancestor)) {
      return true;
    }
    separator = path.lastIndexOf("/", separator - 1);
  }
  return false;
}

export function tracksPath(
  path: string,
  configuration: InitializationConfiguration | undefined,
): boolean {
  if (configuration?.state !== "initialized") {
    return false;
  }
  // Preserve exact behavior via compiled matcher for consistency.
  return tracksPathCompiled(path, compileTrackingMatcher(configuration));
}

function isTrackingTarget(value: unknown): value is TrackingTarget {
  return (
    isRecord(value) &&
    (value.kind === "file" || value.kind === "folder") &&
    typeof value.path === "string" &&
    isNormalizedPath(value.path, value.kind === "folder")
  );
}

function isNormalizedPath(path: string, allowRoot: boolean): boolean {
  if (allowRoot && path.length === 0) {
    return true;
  }
  return (
    path.length > 0 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
