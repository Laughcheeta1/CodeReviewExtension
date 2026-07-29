# Lessons

- When a user specifies an exact hash input, preserve that byte-level contract verbatim and do not introduce a separate identity component unless they ask for one.
- When reformatting code, treat control-flow readability as part of the requirement: use braced, multiline blocks for conditional and loop statements rather than compressed one-line forms.
- Use `pnpm` exclusively for JavaScript dependency management and project scripts; do not invoke `npm`.
- Update the extension build number manually for each new build; do not automate version bumps or alter build scripts unless explicitly requested.
- When a user supplies concrete runtime observations that contradict an inferred explanation, treat the inference as invalid and trace the observed execution path before proposing a cause.
- After implementing a change, manually increment the extension build number, compile a new release artifact, and remove the superseded release artifact.
- When a selection flow must begin with a default multi-selection, use a UI control that can display and modify that preselected set; do not substitute a file dialog that cannot express the intended default.
- When adding persistent state guards around a workflow, verify that existing explicit commands still provide an intentional recovery or reconfiguration path instead of silently becoming no-ops.
- For initialization workflows, verify the end-to-end persistence result—metadata and snapshots on disk—not merely that the UI flow or command completes.
- Do not revalidate explicitly selected initialization candidates against lifecycle caches that are populated only after initialization; use the selected candidate set as the authority for that initialization run.
- When a user asks to reduce editor clutter, remove the inline UI affordance and retain the action through the requested context menu and existing shortcut.
- File-level status actions must support the same meaningful state transitions as their workspace-level counterparts without resetting unrelated tracked files.
- Do not add prominent editor controls such as CodeLens actions unless the user explicitly requests them; keep review actions in the requested menus and shortcuts.
