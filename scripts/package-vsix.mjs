import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVSIX, listFiles, PackageManager } from "@vscode/vsce";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const output = path.join(root, `${manifest.name}-${manifest.version}.vsix`);
const staging = await mkdtemp(path.join(tmpdir(), "code-review-vsix-"));

try {
  const files = await listFiles({ cwd: root, packageManager: PackageManager.None });
  for (const file of files) {
    const destination = path.join(staging, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, file), destination);
  }
  await copyFile(path.join(root, ".vscodeignore"), path.join(staging, ".vscodeignore"));

  // vsce unconditionally runs this hook through npm or yarn. The caller has
  // already built with pnpm; omit only the staging copy's hook to avoid a
  // second package manager while preserving the working-tree manifest.
  const packagedManifest = structuredClone(manifest);
  delete packagedManifest.scripts["vscode:prepublish"];
  await writeFile(
    path.join(staging, "package.json"),
    `${JSON.stringify(packagedManifest, null, 2)}\n`,
  );
  await createVSIX({
    cwd: staging,
    packagePath: output,
    dependencies: false,
    rewriteRelativeLinks: false,
    allowMissingRepository: true,
  });
} finally {
  await rm(staging, { recursive: true, force: true });
}
