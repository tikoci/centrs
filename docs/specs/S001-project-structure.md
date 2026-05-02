# S001: Project Structure

## Status

Accepted baseline.

Metadata:

- Supersedes: none
- Superseded by: none
- Scope: baseline
- Review source: `work/20260430A-initial-design/GOAL.md`

## Context

`centrs` started as a human-authored strawman with project intent distributed across docs, instruction files, source placeholders, and workflow sketches. The repository structure should now act as the first prompt for future agents and contributors.

## Goals

- Keep product intent, architecture, workflow, specs, source, tests, and agent instructions in predictable places.
- Prefer small scoped files over large duplicated markdown documents.
- Make generated docs the default when code, CLI metadata, or schema can be the source of truth.
- Keep runnable project tooling even while major product features are still planned.

## Non-goals

- Implement RouterOS protocol behavior in this spec.
- Freeze the project layout forever.
- Store every idea in a root-level instruction file.

## Repository layout

| Path | Owner |
| --- | --- |
| `README.md` | User-facing overview and CLI manual surface. |
| `AGENTS.md` | Short repository entrypoint for agents. |
| `docs/ARCHITECTURE.md` | Stable system boundaries and cross-cutting concepts. |
| `docs/WORKFLOW.md` | Work/spec/source lifecycle. |
| `docs/specs/S###-*.md` | Accepted requirements and acceptance criteria. |
| `GLOSSARY.txt` | Shared project vocabulary, short term definitions, and cspell-backed reference entries. |
| `.scratch/` | Repo-local transient artifacts and whiteboard material that are not yet durable project sources. |
| `work/<date-topic>/` | Grounding, experiments, plans, and status for exploratory work. |
| `src/` | Bun/TypeScript library and frontend implementations. |
| `test/` | Unit, integration, fixtures, and RouterOS CHR tests. |
| `.github/instructions/` | Copilot-native path-specific instruction rules using `applyTo` metadata. |
| `.github/workflows/` | CI, QA/security, release, pages, and lab automation. |

## Naming rules

- Specs use `docs/specs/S###-short-name.md` with monotonically increasing numbers.
- Prefer descriptive kebab-case names for new prose markdown files unless the file uses an established conventional name such as `README.md`, `AGENTS.md`, `SECURITY.md`, `GOAL.md`, `PLAN.md`, or `STATUS.md`.
- Work items use `work/YYYYMMDDX-short-name/`, where `X` is optional when more than one item starts on the same day.
- Directory `AGENTS.md` files describe only local constraints.
- Generated docs should live under a clearly generated path such as `docs/api/` and be produced by scripts.

## Acceptance criteria

- Root docs explain where to start without repeating the entire product plan.
- Each stable behavior has exactly one spec source of truth.
- Placeholder work remains non-failing in scripts and workflows.
- Future agents can discover relevant rules by path without loading a giant instruction document.
