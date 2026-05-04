---
applyTo: "docs/WORKFLOW.md,docs/specs/**,src/**,test/**,work/**,AGENTS.md,**/AGENTS.md,README.md"
---

# Docs and specs lifecycle

Follow `docs/WORKFLOW.md`.

- Use `work/` for exploration and grounding.
- Promote stable requirements to `docs/specs/S###-*.md`.
- Use YAML front matter in specs for status, supersession, scope, and review source
  instead of ad hoc prose metadata blocks.
- Update specs and tests in the same change as behavior changes.
- Keep root and directory `AGENTS.md` files short; put durable behavior in scoped instructions or specs.
