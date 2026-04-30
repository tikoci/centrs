---
description: Keep instruction file path scopes accurate and minimal.
paths:
  - "AGENTS.md"
  - "**/AGENTS.md"
  - ".claude/CLAUDE.md"
  - ".claude/rules/**"
  - ".github/copilot-instructions.md"
---

When adding or editing a durable instruction, make its `paths` match the files it actually governs.

- Add only the narrowest paths needed.
- Remove unrelated paths immediately.
- Prefer one canonical source per instruction topic; use pointers elsewhere.
- If a rule applies repo-wide, prove that it does before using `**/*`.
- When a rule overlaps another rule or `AGENTS.md`, keep the most specific file normative and turn the other location into a pointer.
