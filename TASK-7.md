# Task overview

Remove the special JSX/TSX RevExt comment placement system and make React
language files use direct `// RevExt: N` line comments like JavaScript and
TypeScript files.

# Goals

- Stop generating JSX expression comments (`{/* RevExt: N */}`) in `.jsx` and
  `.tsx` files.
- Generate direct `// RevExt: N` suffixes for duplicate added lines in React
  language files, without the JSX lexer deciding placement.
- Preserve marker identity, promotion cleanup, and compatibility removal of
  already-generated JSX expression comments.
- Update documentation and tests to describe and verify the new behavior.
- Run the project verification suite, synchronize the extension version, and
  package and inspect a new VSIX.

# Implementation details

1. Inspect the architecture, marker implementation, tests, package scripts,
   and version identifiers. The architecture's marker boundary remains in
   `revext-syntax.ts`, `revext-annotation.ts`, and `revext.ts`; no review-state,
   persistence, or lifecycle behavior should change.
2. Simplify React marker style selection so supported React lines use the
   existing line-comment token (`//`) directly. Remove the unused JSX placement
   lexer and generation branch. Keep the legacy JSX-expression matcher for
   stripping markers produced by earlier extension versions during promotion.
3. Replace parser-valid JSX placement assertions with direct-comment behavior
   assertions. Remove browser/parser tests that require generated JSX to remain
   syntactically valid, because direct comments are intentionally requested by
   the user even inside JSX content.
4. Update `README.md` and the RevExt section of `ARCHITECTURE.md` to document
   direct React comments and the legacy cleanup behavior.
5. Run focused unit checks, type checking, linting, browser/integration checks
   where applicable, then increment `package.json` and `src/extension.ts`
   versions together and build/package the VSIX. Verify the packaged manifest
   and artifact filename.

# Kanban List

- [Done] Inspect current JSX/TSX marker implementation and verification
  coverage.
- [Done] Simplify marker generation and preserve legacy marker cleanup.
- [Done] Update tests and documentation.
- [Done] Run verification and package a versioned VSIX.
- [Done] Review the final diff and report results.

# Findings

- The special JSX behavior is isolated to `src/revext-syntax.ts`; callers in
  `src/revext-annotation.ts` already apply returned suffixes generically.
- React language IDs are `javascriptreact` and `typescriptreact`, so no new
  extension-based dispatch is needed.
- Existing JSX expression markers may already be in tracked files. Keeping
  their matcher for removal prevents old generated comments from surviving
  promotion while ensuring no new JSX markers are emitted.
- Direct `//` suffixes remain parser-accepted by TypeScript but can become
  visible JSX text after transpilation; the browser contract now verifies that
  direct behavior rather than treating it as an error.
- Typecheck, lint, unit, browser, and elevated Extension Host integration
  checks passed. The first sandboxed integration attempt could not start
  Electron, so the same suite was rerun with the required elevated execution
  permission and completed successfully.
