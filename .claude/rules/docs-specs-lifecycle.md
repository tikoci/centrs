---
paths:
  - "docs/specs/**"
  - "src/**"
  - "test/**"
  - "work/**"
  - ".claude/**"
  - ".github/**"
  - "package.json"
  - "README.md"
  - "SECURITY.md"
---

Follow `docs/WORKFLOW.md`.

- Use `work/` for exploration and grounding.
- Promote stable requirements to `docs/specs/S###-*.md`.
- Update specs and tests in the same change as behavior changes.
- Keep root and directory `AGENTS.md` files short; put durable behavior in scoped rules or specs.
