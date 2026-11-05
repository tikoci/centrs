---
applyTo: ".claude/CLAUDE.md,.github/instructions/**,AGENTS.md,**/AGENTS.md,.github/copilot-instructions.md"
---

# Directory AGENTS files

Use scoped instruction files instead of expanding root prompts.

- Root `AGENTS.md` is the entrypoint.
- Directory `AGENTS.md` files contain local constraints only.
- A new centrs-only instruction belongs in the nearest directory `AGENTS.md`.
- A rule that applies across TIKOCI repos belongs in a
  `.github/instructions/*.instructions.md` file with a narrow `applyTo`, so it
  can be vendored between repos. Keep centrs-specific facts out of those files.
- Each `CLAUDE.md` is a one-line file, `@AGENTS.md`, that imports the
  `AGENTS.md` beside it. Use an import rather than a symlink, because symlinks
  do not survive every Windows checkout. No separate `.claude/CLAUDE.md` is
  kept.
- `.github/copilot-instructions.md` is a compatibility pointer.
