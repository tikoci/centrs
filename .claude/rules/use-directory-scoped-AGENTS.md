---
paths:
  - ".claude/CLAUDE.md"
  - "AGENTS.md"
  - "**/AGENTS.md"
  - "src/**/*.ts"
  - "test/**/*.ts"
  - ".github/copilot-instructions.md"
---

Use scoped instruction files instead of expanding root prompts.

- Root `AGENTS.md` is the entrypoint.
- Directory `AGENTS.md` files contain local constraints only.
- `.claude/rules/*` files contain durable single-purpose rules with `paths` metadata.
- `.github/copilot-instructions.md` and `.claude/CLAUDE.md` are compatibility pointers.
