---
applyTo: "src/protocols/**,src/data/**,src/explain.ts,src/explain/**,test/integration/**,test/unit/explain*.test.ts,commands/**,README.md,docs/CONSTITUTION.md,docs/MATRIX.md"
---

# RouterOS grounding

Before implementing a protocol adapter, command, or offline analyzer, ground
the RouterOS facts that shape the shared API. Offline analysis follows the
semantic-evidence rule in `docs/CONSTITUTION.md` → Done definition.

- Prefer rosetta MCP tools for RouterOS command paths, properties, versions,
  changelogs, and documentation before web search.
- Use related tikoci projects as implementation evidence:
  - `tikoci/restraml` — REST schema and inspect output, native API stress lessons.
  - `tikoci/lsp-routeros-ts` — canonicalization and parse-validation patterns.
  - `tikoci/quickchr` — CHR-backed integration test harness.
  - `tikoci/m2ir` — RouterOS protocol IR (WinBox, Nova-error vocabulary).
  - `tikoci/donny` — Dude DB and Nova data.
  - `tikoci/vscode-tikbook`, `tiktui`, `mcp-monorepo/mcp-mikrotik` — interaction patterns.
  - `tikoci-crossref` skill — first agentic index.
- For live operations, record protocol capability, service/API/CLI path,
  default port, auth model, local dependency, validation source, CHR test shape,
  security warning, and failure mode in the relevant `commands/<name>/README.md`.
- For MAC Telnet, RoMON, WinBox Terminal, WinBox CDB, and packet-level
  behavior, capture reference implementations or Wireshark dissectors as
  notes inside the relevant `commands/<name>/README.md` — do not introduce a
  new top-level docs directory.
- A protocol cell does not advance in `docs/MATRIX.md` without a CHR-passing
  example in `commands/<name>/examples.md`. RouterOS behavior cannot be
  inferred from code review alone.
