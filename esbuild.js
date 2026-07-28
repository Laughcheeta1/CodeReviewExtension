const esbuild = require("esbuild");
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
async function build() {
  const context = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vscode"],
    outfile: "dist/extension.js",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: "info",
  });
  if (watch) await context.watch();
  else {
    await context.rebuild();
    await context.dispose();
  }
}
build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
