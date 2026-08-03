import assert from "node:assert/strict";
import test from "node:test";
import {
  ignoredPathsFromFiles,
  type IgnoreFile,
} from "../src/ignore-matcher.ts";

/*
 * The extension owns ignore evaluation. These tests exercise the same pure
 * matcher used by the VS Code workspace service, so they do not need a Git
 * repository and cannot accidentally make Git the source of eligibility.
 */
test("workspace ignore matching supports root and nested rules", () => {
  const files: readonly IgnoreFile[] = [
    {
      directory: "",
      contents: [
        "ignored-root.txt",
        "ignored-folder/*",
        "!ignored-folder/allowed.txt",
        "*.secret",
        "!allowed.secret",
        "/root-only.txt",
        "space ignored.txt",
        "**/.venv/",
      ].join("\n"),
    },
    {
      directory: "nested",
      contents: ["*.generated", "!allowed.generated", "/root-only.txt"].join(
        "\n",
      ),
    },
    {
      directory: "nested/deeper",
      contents: ["*.secret", "!allowed.secret"].join("\n"),
    },
  ];
  const paths = [
    "ignored-root.txt",
    "ignored-folder/hidden.txt",
    "ignored-folder/allowed.txt",
    "credentials.secret",
    "allowed.secret",
    "root-only.txt",
    "nested/root-only.txt",
    "nested/file.generated",
    "nested/allowed.generated",
    "nested/deeper/credentials.secret",
    "nested/deeper/allowed.secret",
    "ordinary.txt",
    "space ignored.txt",
    "backend/.venv/lib64/python3.13/site-packages/example/WHEEL",
  ];

  assert.deepEqual(
    [...ignoredPathsFromFiles(paths, files)].sort(),
    [
      "backend/.venv/lib64/python3.13/site-packages/example/WHEEL",
      "credentials.secret",
      "ignored-folder/hidden.txt",
      "ignored-root.txt",
      "nested/deeper/credentials.secret",
      "nested/file.generated",
      "nested/root-only.txt",
      "root-only.txt",
      "space ignored.txt",
    ],
  );
});

test("nested negation cannot re-include a file below an ignored directory", () => {
  const files: readonly IgnoreFile[] = [
    { directory: "", contents: "vendor/\n" },
    { directory: "vendor", contents: "!allowed.txt\n" },
  ];

  assert.deepEqual(
    [...ignoredPathsFromFiles(["vendor/allowed.txt", "vendor/other.txt"], files)],
    ["vendor/allowed.txt", "vendor/other.txt"],
  );
});

test("only supplied workspace .gitignore files contribute rules", () => {
  const files: readonly IgnoreFile[] = [
    { directory: "", contents: "workspace-ignored.txt\n" },
    { directory: "backend", contents: "nested-ignored.txt\n" },
  ];

  assert.deepEqual(
    [...ignoredPathsFromFiles(
      [
        "workspace-ignored.txt",
        "backend/nested-ignored.txt",
        "global-exclude.txt",
        "info-exclude.txt",
      ],
      files,
    )].sort(),
    ["backend/nested-ignored.txt", "workspace-ignored.txt"],
    "Git global configuration and .git/info/exclude are not inputs",
  );
});

test("ignore matching accepts VS Code-style Windows separators", () => {
  const files: readonly IgnoreFile[] = [
    { directory: "", contents: "generated/\n" },
  ];

  assert.deepEqual(
    [...ignoredPathsFromFiles(["generated\\build\\output.js"], files)],
    ["generated\\build\\output.js"],
  );
});
