---
applyTo: "src/**,docs/**,README.md,package.json,typedoc.json"
---

# Generated docs

Prefer generated documentation when code, CLI metadata, schema, or protocol models are the source of truth.

- Write typed exports, JSDoc, command metadata, and schemas so TypeDoc and the CLI-doc generator (`scripts/gen-cli-docs.ts` → `docs/CLI.md`) can reuse them.
- Avoid copying option tables by hand across README, API docs, MCP docs, and help output.
- Human-authored docs should explain concepts, workflow, and decisions that cannot be generated reliably.
