# Lessons

- When a user specifies an exact hash input, preserve that byte-level contract verbatim and do not introduce a separate identity component unless they ask for one.
- When reformatting code, treat control-flow readability as part of the requirement: use braced, multiline blocks for conditional and loop statements rather than compressed one-line forms.
- Use `pnpm` exclusively for JavaScript dependency management and project scripts; do not invoke `npm`.
- Update the extension build number manually for each new build; do not automate version bumps or alter build scripts unless explicitly requested.
- When a user supplies concrete runtime observations that contradict an inferred explanation, treat the inference as invalid and trace the observed execution path before proposing a cause.
- After implementing a change, manually increment the extension build number, compile a new release artifact, and remove the superseded release artifact.
