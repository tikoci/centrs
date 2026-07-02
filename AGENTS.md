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
| `.mcp.json`                 | Shared MCP server config; no secrets or credentials.               |
| `.github/instructions/`     | Path-scoped Copilot instructions with `applyTo` metadata.          |
| `.github/workflows/`        | CI, QA/security, release, docs, and lab automation.                |

## Instruction map

Copilot reads `.github/instructions/*.instructions.md`; Codex and Claude do not.
When an issue names one of those files as required context, read it directly.
Otherwise, use this index to find the path-scoped rule that may apply:

| File | Governs |
| ---- | ------- |
| `actionable-errors.instructions.md` | Error shape, details pages, and actionable diagnostics. |
| `ci-test-tiers-and-release-versioning.instructions.md` | CI tiers, release channels, and versioning workflow files. |
| `cspell-glossary.instructions.md` | Project spelling dictionary and glossary maintenance. |
| `descriptive-prose-file-names.instructions.md` | Prose filename conventions for docs and scratch notes. |
| `directory-agents.instructions.md` | Root and directory `AGENTS.md` conventions. |
| `done-definition.instructions.md` | CHR-backed done definition and integration-test procedure. |
| `generated-docs.instructions.md` | Generated docs ownership and drift rules. |
| `git-hooks.instructions.md` | Git hook and CI gate wiring. |
| `github-actions-dispatch.instructions.md` | Manual workflow dispatch inputs. |
| `github-actions-rich-data.instructions.md` | GitHub Actions summaries and machine-readable output. |
| `github-security-quality.instructions.md` | Security scanning, credentials, and quality-sensitive surfaces. |
| `instruction-scopes.instructions.md` | Narrow `applyTo` scopes and instruction-source ownership. |
| `linting.instructions.md` | Lint, typecheck, spelling, markdown, and secretlint gates. |
| `python-uv.instructions.md` | Python and uv conventions when Python files are touched. |
| `readme-cli-manual.instructions.md` | README as the temporary CLI manual. |
| `readme-dependencies.instructions.md` | README dependency and install notes. |
| `routeros-grounding.instructions.md` | RouterOS fact grounding and promotion targets. |
| `scratch-directory.instructions.md` | `.scratch/` limits and non-authoritative status. |
| `use-bun.instructions.md` | Bun-first TypeScript and test workflow. |
| `vscode-files.instructions.md` | VS Code workspace files and related tool config. |

For new durable instructions, prefer the nearest directory `AGENTS.md` when the
rule must be portable across harnesses. Edit an existing `.github/instructions/`
file only when the rule is Copilot-specific or when keeping an existing
path-scoped pointer in sync.

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
