---
applyTo: ".claude/CLAUDE.md,.github/instructions/**,AGENTS.md,**/AGENTS.md,.github/copilot-instructions.md"
---

# Directory AGENTS files

Use scoped instruction files instead of expanding root prompts.

- Root `AGENTS.md` is the entrypoint.
- Directory `AGENTS.md` files contain local constraints only.
- `.github/instructions/*.instructions.md` files contain durable path-specific Copilot instructions using `applyTo`.
- `.github/copilot-instructions.md` and `.claude/CLAUDE.md` are compatibility pointers.
