import { createHash } from "node:crypto";

export function pathHash(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

export function storageFileName(path: string): string {
  return `${pathHash(path)}.json`;
}

export function snapshotFileName(path: string, digest: string): string {
  return `${pathHash(path)}.${digest}.gz`;
}

export function folderHash(folderUri: string): string {
  return createHash("sha256").update(folderUri).digest("hex");
}

