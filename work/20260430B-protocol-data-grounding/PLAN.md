# Plan: protocol/data grounding

## Approach

Use this work item as the evidence collector. Promote only stable conclusions to
specs or durable instructions after the matrices are filled.

## Workstreams

1. Protocol matrix
   - Cover REST API, native API, SSH, SNMP, MNDP, MAC Telnet, RoMON, WinBox
     Terminal, file transfer, and proxy/eventing surfaces.
   - Capture capabilities, RouterOS service/path/port, auth, local
     dependencies, validation source, CHR/lab testability, security warnings,
     failure modes, source references, and open questions.

2. Data-source matrix
   - Cover explicit input, environment variables, SQLite cache, WinBox CDB,
     Dude DB, MNDP observations, and credential storage/import behavior.
   - Capture authority level, provenance, schema/file format, credential
     handling, persistence, sample/fixture needs, and source references.

3. Native API eventing
   - Reconcile RouterOS API docs, `tiktui`, and `restraml` around `.tag`,
     `/listen`, monitor commands, `/cancel`, and multiplexing risks.
   - Decide how this affects future SSE/HTTP-stream proxy work without making
     it part of the first REST retrieve alpha.

4. Discovery and layer-2 access
   - Ground MNDP from `mcp-mikrotik` and RouterOS docs.
   - Ground MAC Telnet from the legacy haakonnessjoen implementation and
     RouterOS MAC server docs.
   - Inventory missing RoMON, WinBox Terminal, WinBox protocol, CDB, and
     Wireshark dissector references.

5. CHR/lab strategy
   - Use `quickchr`, `restraml`, `tiktui`, and `donny` as evidence for when CHR
     integration tests should be preferred over mocks.
   - Decide what belongs in non-gating `lab.yaml` experiments versus gated
     integration tests.

6. Agentic workflow
   - Keep root `AGENTS.md` short.
   - Strengthen `.github/instructions/routeros-grounding.instructions.md` as the
     canonical path-specific rule for protocol/data grounding.
   - Record the deferred `SKILL.md`/custom-agent decision and revisit trigger in
     `STATUS.md`.

## Promotion path

1. Fill this work item.
2. Update S006 with grounded alpha decisions.
3. Update S002/S003 only for stable protocol/data-source requirements.
4. Create implementation work only after the relevant spec and test shape are
   clear.
