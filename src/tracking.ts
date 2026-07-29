export interface TrackingTarget {
  readonly kind: "file" | "folder";
  readonly path: string;
}  // RevExt: 1
// RevExt: 8
export interface InitializationConfiguration {
  readonly schemaVersion: 1;
  readonly state: "disabled" | "initialized";
  readonly targets?: readonly TrackingTarget[];
}  // RevExt: 2
// RevExt: 9
export function parseInitializationConfiguration(
  value: unknown,
): InitializationConfiguration | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return undefined;  // RevExt: 15
  }  // RevExt: 17
  if (value.state === "disabled") {
    return { schemaVersion: 1, state: "disabled" };
  }  // RevExt: 18
  if (
    value.state !== "initialized" ||
    !Array.isArray(value.targets) ||
    value.targets.length === 0
  ) {
    return undefined;  // RevExt: 16
  }  // RevExt: 19
  const targets: TrackingTarget[] = [];
  for (const target of value.targets) {
    if (!isTrackingTarget(target)) {
      return undefined;
    }
    targets.push(target);
  }  // RevExt: 20
  return { schemaVersion: 1, state: "initialized", targets };
}  // RevExt: 3
// RevExt: 10
export function tracksPath(
  path: string,
  configuration: InitializationConfiguration | undefined,
): boolean {
  return (  // RevExt: 22
    configuration?.state === "initialized" &&
    configuration.targets?.some((target) =>
      target.kind === "file"
        ? target.path === path
        : target.path.length === 0 ||
          path === target.path ||
          path.startsWith(`${target.path}/`),
    ) === true
  );  // RevExt: 25
}  // RevExt: 4
// RevExt: 11
function isTrackingTarget(value: unknown): value is TrackingTarget {
  return (  // RevExt: 23
    isRecord(value) &&
    (value.kind === "file" || value.kind === "folder") &&
    typeof value.path === "string" &&
    isNormalizedPath(value.path, value.kind === "folder")
  );  // RevExt: 26
}  // RevExt: 5
// RevExt: 12
function isNormalizedPath(path: string, allowRoot: boolean): boolean {
  if (allowRoot && path.length === 0) {
    return true;
  }  // RevExt: 21
  return (  // RevExt: 24
    path.length > 0 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((part) => part.length > 0 && part !== "." && part !== "..")
  );  // RevExt: 27
}  // RevExt: 6
// RevExt: 13
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}  // RevExt: 7
// RevExt: 14