---
applyTo: "src/protocols/**,docs/specs/S002-protocols-and-access.md,docs/specs/S006-alpha-first-command.md,test/integration/**,README.md"
---

# RouterOS protocol grounding

Before implementing a protocol adapter or CLI command, ground the RouterOS facts that shape the shared API.

- Prefer rosetta MCP tools for RouterOS command paths, properties, versions, changelogs, and documentation before web search.
- Record protocol capability, service/API/CLI path, default port, auth model, local dependency, validation source, CHR test shape, security warning, and failure mode.
- Use related tikoci projects as implementation evidence: `restraml` for REST/schema/inspect data, `lsp-routeros-ts` for canonicalization, `quickchr` for CHR tests, and `vscode-tikbook`/`tiktui` for interaction patterns.
- Do not let the first CLI command force settings or environment names before the protocol matrix shows they generalize.
