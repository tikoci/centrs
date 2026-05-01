---
applyTo: "work/**,src/protocols/**,src/data/**,docs/WORKFLOW.md,docs/specs/S002-protocols-and-access.md,docs/specs/S003-device-discovery-and-cache.md,docs/specs/S006-alpha-first-command.md,test/integration/**,README.md"
---

# RouterOS protocol grounding

Before implementing a protocol adapter or CLI command, ground the RouterOS facts that shape the shared API.

- Use `work/<date-topic>/` for moderate RouterOS protocol, data-source, CHR lab, or cross-project porting research before changing specs or source.
- Prefer rosetta MCP tools for RouterOS command paths, properties, versions, changelogs, and documentation before web search.
- Record protocol capability, service/API/CLI path, default port, auth model, local dependency, validation source, CHR test shape, security warning, and failure mode.
- Record data-source authority, provenance, credential handling, persistence behavior, fixture needs, and import/export boundaries before implementing cache, CDB, Dude DB, or discovery imports.
- Use `tikoci-crossref` and related RouterOS skills as the first agentic index. Do not duplicate those skills into this repo unless repeated work proves a repo-local skill is needed.
- Use related tikoci projects as implementation evidence: `restraml` for REST/schema/inspect data and native API stress lessons, `lsp-routeros-ts` for canonicalization, `quickchr` for CHR tests, `vscode-tikbook`/`tiktui` for interaction patterns, `mcp-monorepo/mcp-mikrotik` for MNDP, and `donny` for Dude DB/Nova data.
- For MAC Telnet, RoMON, WinBox Terminal, WinBox CDB, and packet-level behavior, capture reference implementations, Wireshark dissectors, or lab evidence in `work/` before promoting requirements.
- Do not let the first CLI command force settings or environment names before the protocol matrix shows they generalize.
