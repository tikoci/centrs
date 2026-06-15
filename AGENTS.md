# Agents

Three files cover this project. Read them in this order:

1. `docs/CONSTITUTION.md` — the load-bearing rules. Validation, envelope,
   errors, settings, identity, protocol selection, done definition.
2. `docs/MATRIX.md` — the command×protocol grid. The only status surface.
   Find the highest-priority not-`CHR-passed` cell; that is the next work.
3. `commands/<name>/README.md` and `commands/<name>/examples.md` — the
   executable spec for the cell you're working on.

When those three are clear, write code or tests. Do not write more prose.

## Done definition

A feature is done when its examples in `commands/<name>/examples.md` are green
on real CHR via `bun run test:integration`. Code existing is not done. Unit
tests passing is not done. The **normative** definition is
[`docs/CONSTITUTION.md` → Done definition](docs/CONSTITUTION.md#done-definition);
the integration-test procedure is in
`.github/instructions/done-definition.instructions.md`.

## Quick commands

```bash
bun install
bun run lint
bun run test
bun run test:integration
bun run build
bun run lint:ci
```

## Repo map

| Path                        | Purpose                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `README.md`                 | Product overview and CLI manual.                                   |
| `docs/CONSTITUTION.md`      | Load-bearing rules.                                                |
| `docs/MATRIX.md`            | Command×protocol grid; only status source of truth.                |
| `commands/<name>/`          | Per-command README + examples (the executable spec).               |
| `src/`                      | Bun/TypeScript source.                                             |
| `test/`                     | Unit, integration, and fixture space.                              |
| `.github/instructions/`     | Path-scoped Copilot instructions with `applyTo` metadata.          |
| `.github/workflows/`        | CI, QA/security, release, docs, and lab automation.                |

## Rules of thumb

- Prefer `rosetta` MCP tools for RouterOS facts before web search.
- Update the constitution, the matrix, or a per-command file — not a new doc.
- A directory `AGENTS.md` is for local constraints only.
- `.scratch/` is not authoritative and must not be referenced from durable
  files. Treat it as in-flight only.

## Verification

Run `bun run lint && bun run test && bun run build` before finishing code
changes. Run `bun run lint:ci` when changing docs, instructions, security
config, spelling dictionaries, or workflow files.

**Transport / RouterOS-touching code is not done until
`bun run test:integration` passes.** This is the only "done" rule for cells
that involve a router.

## Security

Follow `SECURITY.md` and
`.github/instructions/github-security-quality.instructions.md`. Treat
credential handling, RouterOS write execution, proxy listeners, and local
discovery data as security-sensitive surfaces.

## Do not

- Do not commit secrets, real router credentials, private CDB/Dude databases,
  or packet captures with sensitive data.
- Do not silently fall back to another protocol when the caller pinned `--via`.
- Do not make generated output the hand-edited source of truth.
- Do not add new docs to capture status, plans, or roadmaps. Use the matrix
  and per-command files.
- Do not disable validation to make a test pass; validation is the product.
