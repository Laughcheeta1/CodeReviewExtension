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

export function tracksPath(
  path: string,
  configuration: InitializationConfiguration | undefined,
): boolean {
  return (
    configuration?.state === "initialized" &&
    configuration.targets?.some((target) =>
      target.kind === "file"
        ? target.path === path
        : target.path.length === 0 ||
          path === target.path ||
          path.startsWith(`${target.path}/`),
    ) === true
  );
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
