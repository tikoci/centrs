# Changelog

All notable changes to this repository should be recorded here.

The product evolves as a stream of changes; there are no alpha gates.
Per-feature status is tracked in `docs/MATRIX.md`. Use this file for
documenting cross-cutting shifts that affect contributors and consumers.

## Unreleased

### Changed

- **Workflow restructure.** Replaced `docs/specs/`, `docs/WORKFLOW.md`,
  `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, and `work/` with three durable
  surfaces:
  - `docs/CONSTITUTION.md` — the load-bearing rules (validation as product,
    result envelope, error model + URL scheme, settings precedence, identity,
    protocol selection, done = CHR-passed).
  - `docs/MATRIX.md` — command×protocol grid; the only status surface.
  - `commands/<name>/{README,examples}.md` — per-command design and
    executable example list that gates "done."
- Done definition codified in
  `.github/instructions/done-definition.instructions.md`: a feature is done
  when its examples are green on real CHR via `bun run test:integration`.
  Disabling validation to make a test pass is forbidden; validation is the
  product.

### Removed

- `docs/specs/S001`–`S008`, `docs/WORKFLOW.md`, `docs/ROADMAP.md`,
  `docs/ARCHITECTURE.md`, all of `work/`, and the
  `docs-specs-lifecycle` / `work-directory` / `integration-testing`
  instruction files. Their durable content folded into the constitution and
  per-command files; the rest was scaffolding for a workflow that did not
  pay off.
