# Agent Workflow

Start here, then load only the files relevant to the paths you are changing:

- `README.md` explains the product and CLI direction.
- `docs/ARCHITECTURE.md` explains system boundaries.
- `docs/WORKFLOW.md` explains how `work/`, specs, source, and tests stay aligned.
- `docs/specs/` contains accepted requirements.
- `work/20260430A-initial-design/GOAL.md` is historical grounding, not the active source of truth.
- Directory-level `AGENTS.md` files contain local rules.
- `.claude/rules/*` contains single-purpose scoped rules with `paths` metadata.

Use fleet/subagents for independent workstreams such as docs, source, tests, workflows, and security. Keep SQL todo state authoritative when it is available.

Prefer updating a scoped rule, spec, or directory `AGENTS.md` over adding more root-level prose. If an instruction gap appears during work, capture it in the relevant work item status and then promote it to the smallest durable instruction file.

## Quick commands

```bash
bun install
bun run lint
bun run test
bun run build
bun run lint:ci
```

## Repo map

| Path | Purpose |
| --- | --- |
| `README.md` | Product overview and planned CLI manual. |
| `docs/ARCHITECTURE.md` | System boundaries and core concepts. |
| `docs/WORKFLOW.md` | Work item to spec to source workflow. |
| `docs/specs/` | Stable requirements and acceptance criteria. |
| `work/` | Exploration, grounding, and multi-session context. |
| `src/` | Bun/TypeScript source. |
| `test/` | Unit, integration, and fixture space. |
| `.claude/rules/` | Scoped durable instructions with `paths` metadata. |
| `.github/workflows/` | CI, QA/security, release, docs, and lab automation. |

## Working rules

- Preserve RouterOS syntax and semantics; do not invent high-level configuration wrappers.
- Keep settings vocabulary aligned across API, CLI, MCP, TUI, and proxy surfaces.
- Prefer real RouterOS/CHR grounding through `quickchr` for behavior that depends on RouterOS.
- Keep docs generated from code or schema when that source can be authoritative.

## Verification

Run `bun run lint && bun run test && bun run build` before finishing code changes. Run `bun run lint:ci` when changing docs, instructions, security config, spelling dictionaries, or workflow files.

## Security

Follow `SECURITY.md` and `.claude/rules/github-security-and-quality-scanning.md`. Treat credential handling, RouterOS write execution, proxy listeners, and local discovery data as security-sensitive surfaces.

## Do not

- Do not commit secrets, real router credentials, private CDB/Dude databases, or packet captures with sensitive data.
- Do not silently fall back to another protocol when the caller requested a specific `via`.
- Do not make generated output the hand-edited source of truth.
- Do not expand root instructions when a scoped rule, spec, or directory `AGENTS.md` would be more precise.
