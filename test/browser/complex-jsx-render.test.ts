import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { revExtEdits } from "../../src/revext.ts";

const execute = promisify(execFile);

interface Fixture {
  readonly fileName: string;
  readonly languageId: "javascriptreact" | "typescriptreact";
}

const fixtures: readonly Fixture[] = [
  {
    fileName: "complex-dashboard.jsx",
    languageId: "javascriptreact",
  },
  {
    fileName: "complex-dashboard.tsx",
    languageId: "typescriptreact",
  },
];

test("renders annotated complex JSX and TSX in a real browser", async (context) => {
  const browser = await findBrowser();
  if (browser === undefined) {
    context.skip("No supported headless browser is installed.");
    return;
  }
  if (!(await browserWorks(browser))) {
    context.skip("The installed headless browser cannot start in this environment.");
    return;
  }

  for (const fixture of fixtures) {
    await renderFixture(browser, fixture);
  }
});

async function findBrowser(): Promise<string | undefined> {
  for (const candidate of ["google-chrome", "chromium", "chromium-browser"]) {
    try {
      await execute(candidate, ["--version"]);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function browserWorks(browser: string): Promise<boolean> {
  try {
    const result = await execute(browser, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--dump-dom",
      "about:blank",
    ]);
    return result.stdout.includes("<html");
  } catch {
    return false;
  }
}

async function renderFixture(browser: string, fixture: Fixture): Promise<void> {
  const source = await readFile(
    path.join("test", "fixtures", fixture.fileName),
    "utf8",
  );
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const addedLines = new Set(lines.map((_, index) => index + 1));
  const annotation = revExtEdits(
    lines,
    addedLines,
    fixture.languageId,
    1,
  );
  const annotated = lines.map((line, index) => {
    const edit = annotation.edits.find((value) => value.line === index + 1);
    return edit === undefined ? line : `${line}${edit.suffix}`;
  });
  const compiled = ts.transpileModule(annotated.join("\n"), {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      jsxFactory: "createElement",
      jsxFragmentFactory: "Fragment",
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: fixture.fileName,
    reportDiagnostics: true,
  });
  assert.deepEqual(compiled.diagnostics ?? [], [], fixture.fileName);

  const directory = await mkdtemp(path.join(tmpdir(), "revext-jsx-browser-"));
  const htmlPath = path.join(directory, "fixture.html");
  try {
    await writeFile(htmlPath, browserDocument(compiled.outputText));
    const result = await execute(browser, [
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--dump-dom",
      "--virtual-time-budget=1000",
      `--user-data-dir=${path.join(directory, "chrome-user-data")}`,
      `file://${htmlPath}`,
    ], { maxBuffer: 4 * 1024 * 1024 });
    const rendered = result.stdout;
    assert.match(rendered, /data-render-status="rendered"/, fixture.fileName);
    assert.match(rendered, /Operations dashboard/, fixture.fileName);
    assert.match(rendered, /Revenue engine/, fixture.fileName);
    assert.match(rendered, /data-team="all"/, fixture.fileName);
    const renderedMarkup = rendered.split("<script>", 1)[0] ?? rendered;
    assert.match(renderedMarkup, /RevExt:/, fixture.fileName);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function browserDocument(compiled: string): string {
  const script = `
function appendChild(parent, child) {
  if (Array.isArray(child)) {
    for (const nested of child) {
      appendChild(parent, nested);
    }
    return;
  }
  if (child === null || child === undefined || child === false) {
    return;
  }
  if (child.nodeType !== undefined) {
    parent.appendChild(child);
    return;
  }
  parent.appendChild(document.createTextNode(String(child)));
}

function Fragment(props) {
  return props.children;
}

function createElement(type, props, ...children) {
  const normalizedProps = props ?? {};
  const childValue = children.length === 1 ? children[0] : children;
  if (typeof type === "function") {
    return type({ ...normalizedProps, children: childValue });
  }
  const element = document.createElement(type);
  for (const [key, value] of Object.entries(normalizedProps)) {
    if (
      key === "children" ||
      key === "key" ||
      key === "ref" ||
      key.startsWith("on") ||
      value === false ||
      value === null ||
      value === undefined
    ) {
      continue;
    }
    const attribute = key === "className" ? "class" : key;
    element.setAttribute(attribute, value === true ? "" : String(value));
  }
  for (const child of children) {
    appendChild(element, child);
  }
  return element;
}

const fixtureModule = { exports: {} };
(function (module, exports) {
${compiled}
})(fixtureModule, fixtureModule.exports);

const mount = document.getElementById("mount");
try {
  appendChild(mount, fixtureModule.exports.Dashboard({ selectedTeam: "all" }));
  mount.dataset.renderStatus = "rendered";
} catch (error) {
  mount.dataset.renderStatus = "error";
  mount.dataset.renderError = String(error);
}
`;
  const safeScript = script.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html>
  <body>
    <div id="mount" data-render-status="pending"></div>
    <script>${safeScript}</script>
  </body>
</html>
`;
}
