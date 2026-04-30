# Agent Workflow

This repository uses small, linked files instead of one large project prompt. The intended path is:

```text
work/<date-topic>/GOAL.md -> work/<date-topic>/PLAN.md -> docs/specs/S###-topic.md -> src/** + test/**
```

## When to use `work/`

Create or update a `work/<date-topic>/` directory when the task needs exploration, multi-session grounding, RouterOS interoperability research, test-data collection, or reconciliation of conflicting notes. A work item may contain:

- `GOAL.md` for the problem statement and source material.
- `PLAN.md` for the execution plan.
- `STATUS.md` for outcomes, decisions, and instruction gaps found during the work.
- supporting artifacts in subdirectories when they are useful and safe to commit.

Small bug fixes do not need a new work item when the relevant spec is already clear.

## When to update specs

Use `docs/specs/S###-*.md` for stable requirements and acceptance criteria. Specs should be updated in the same change as code when behavior changes. If code and spec disagree:

- fix code when the spec is clear and current,
- fix the spec and code when the spec is wrong but the behavior is in scope,
- create a work item when the right behavior is unclear.

## Spec lifecycle

Specs are normative only when their status is `Accepted`.

| Status | Meaning |
| --- | --- |
| `Draft` | Proposed direction; useful for discussion but not a contract. |
| `Accepted` | Current source of truth for the scoped behavior. |
| `Superseded` | Kept for history; replaced by another spec and no longer normative. |
| `Obsolete` | Historical only; the behavior or direction is intentionally abandoned. |

Each spec should include a short metadata block near the top:

```text
Status: Draft | Accepted | Superseded | Obsolete
Supersedes: S### or none
Superseded by: S### or none
Scope: extends | replaces | baseline
Review source: work path, issue, PR, or none
```

Prefer **extends** when old behavior remains valid and the new spec adds a narrower rule. Use **replaces** when the old behavior is wrong, misleading, or no longer supported. Superseded specs stay readable but must link to the replacement and clearly state that they are non-normative.

Avoid “delta-only” specs that require reading two long documents to understand the current behavior. A spec that extends another spec should restate the effective rule for its own scope and link the parent for context.

## Traceability

When a behavior is intentional and non-obvious, cite the governing spec ID from code comments, PR descriptions, or module docs. New user-facing behavior should link from README, generated docs, or CLI help back to the governing spec when that helps future agents understand why it exists.

## Agent instructions

Keep instructions scoped and auditable:

- Root `AGENTS.md` is the entrypoint.
- Directory `AGENTS.md` files contain only local constraints.
- `.claude/rules/*` contains single-purpose rules with `paths` metadata.
- `.github/copilot-instructions.md` and `.claude/CLAUDE.md` are compatibility pointers, not separate sources of truth.

## Parallel work

Use fleet-style execution for independent tasks: inventory, docs, code, tests, workflows, and security can usually run in parallel. Serialize only when a todo truly depends on another todo's output. SQL todo state is the source of truth when available.

## Work item sizing

Keep work items reviewable:

- `GOAL.md` should state the problem, links, and constraints.
- `PLAN.md` should be a short execution plan, not a parallel spec.
- `STATUS.md` should hold decisions, test results, and links to promoted specs or PRs.
- Split large decisions into separate specs instead of one checkpoint narrative.

## GitHub issues, PRs, and security work

When work is tied to a GitHub issue, PR, CodeQL alert, dependency review, or security finding, update the linked GitHub artifact as well as the repository docs/specs. `SECURITY.md` summarizes the intended scanning posture; the GitHub Security tab is the live alert state.

Use this transition once the project moves to GitHub issue/PR flow:

1. Issue captures user-visible goal and links any prior work item.
2. Work item captures exploration when needed.
3. Spec update captures durable behavior.
4. Code and tests implement the accepted spec.
5. PR description links issue, work item, and spec IDs.
6. Issue closes only after merge and docs/specs are updated.
