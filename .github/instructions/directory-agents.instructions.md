---
applyTo: ".claude/CLAUDE.md,.github/instructions/**,AGENTS.md,**/AGENTS.md,.github/copilot-instructions.md"
---

# Directory AGENTS files

Use scoped instruction files instead of expanding root prompts.

- Root `AGENTS.md` is the entrypoint.
- Directory `AGENTS.md` files contain local constraints only.
- New portable instructions belong in the nearest directory `AGENTS.md`, not in
  a new `.github/instructions/*.instructions.md` file.
- Existing `.github/instructions/*.instructions.md` files contain path-specific
  Copilot instructions using `applyTo`; edit them to keep Copilot-specific
  pointers and existing path scopes accurate.
- `.github/copilot-instructions.md` and `.claude/CLAUDE.md` are compatibility pointers.
