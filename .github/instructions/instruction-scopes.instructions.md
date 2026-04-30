---
applyTo: "AGENTS.md,**/AGENTS.md,.claude/CLAUDE.md,.github/instructions/**,.github/copilot-instructions.md"
---

# Instruction scopes

When adding or editing a durable instruction, make its `applyTo` match the files it actually governs.

- Add only the narrowest patterns needed.
- Remove unrelated patterns immediately.
- Prefer one canonical source per instruction topic; use pointers elsewhere.
- If an instruction applies repo-wide, prove that it does before using `**/*`.
- When an instruction overlaps another instruction or `AGENTS.md`, keep the most specific file normative and turn the other location into a pointer.
