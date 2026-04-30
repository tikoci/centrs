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

## Agent instructions

Keep instructions scoped and auditable:

- Root `AGENTS.md` is the entrypoint.
- Directory `AGENTS.md` files contain only local constraints.
- `.claude/rules/*` contains single-purpose rules with `paths` metadata.
- `.github/copilot-instructions.md` and `.claude/CLAUDE.md` are compatibility pointers, not separate sources of truth.

## Parallel work

Use fleet-style execution for independent tasks: inventory, docs, code, tests, workflows, and security can usually run in parallel. Serialize only when a todo truly depends on another todo's output. SQL todo state is the source of truth when available.

## GitHub issues, PRs, and security work

When work is tied to a GitHub issue, PR, CodeQL alert, dependency review, or security finding, update the linked GitHub artifact as well as the repository docs/specs. `SECURITY.md` summarizes the intended scanning posture; the GitHub Security tab is the live alert state.
