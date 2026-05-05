# Status: protocol/data grounding

## Current state

This work item is open but the first grounding pass is complete. The matrices now
cover the planned alpha decision points, the main RouterOS doc pages are pinned,
and the remaining gaps are explicit enough to keep source implementation out of
scratch mode.

## Initial decisions

- Defer repo-level `SKILL.md`.
- Defer custom agents.
- Use existing user-level RouterOS skills plus scoped repo instructions.
- Treat `work/` as the default home for moderate protocol/data/lab research.
- Keep S006 Draft until protocol/data matrices justify alpha decisions.

## Initial evidence captured

- `quickchr` is the CHR/QEMU integration-test reference.
- `restraml` is the REST schema, `/console/inspect`, deep-inspect, and native
  API stress/reference source.
- `lsp-routeros-ts` is the validation and canonicalization reference.
- `tiktui` is the REST-versus-native-API eventing and SSE presentation reference.
- `mcp-monorepo/mcp-mikrotik` is the MNDP discovery reference.
- `donny` is the Dude DB and Nova codec reference.
- `/Users/amm0/Lab/Legacy/mac-telnet` is the local MAC Telnet reference.
- Wireshark dissector, RoMON implementation, WinBox Terminal, and WinBox CDB
  references still need deeper inventory.
- Rosetta confirmed the RouterOS API, REST API, MAC server, RoMON, and neighbor
  discovery documentation pages and command paths.
- Native API eventing facts are grounded enough to keep it as the strategic
  future eventing adapter while excluding it from the first REST retrieve alpha.
- MNDP and MAC Telnet are grounded enough for target-model planning, but both
  still require L2-capable lab work before implementation.
- Dude DB is grounded through `donny`; it can contain plaintext credentials and
  must be treated as secret-bearing import input.
- WinBox Terminal remains a high-risk research gap, and the broader WinBox CDB
  storage/import model still needs more evidence even though read-only lookup is
  acceptable for alpha planning.

## Alpha decision checkpoint

- First transport remains `rest-api` for a read-only retrieve command.
- Alpha device sources are explicit input plus environment variables, with
  read-only WinBox CDB lookup available for named-device enrichment.
- Credential storage remains out of alpha.
- Broad WinBox CDB import/persist behavior, Dude DB, persistent cache, and
  discovery-backed name resolution remain planned surfaces rather than alpha
  blockers.
- Native API remains the strategic eventing/proxy transport after the first REST
  retrieve loop; MNDP, MAC Telnet, RoMON, and WinBox Terminal still need their
  own implementation-time grounding.
- S006 remains Draft because CLI parser choice, first integration-test host
  shape, exact retrieve envelope field names, and exact group-fan-out semantics
  still need implementation-time decisions.

## Review incorporation checkpoint

- The May 1 scratch review has been triaged into committed work artifacts instead
  of being referenced as a durable source.
- WinBox CDB is now recorded as a strong candidate for the first `centrs devices`
  data target, but still provisional until its format, encryption behavior, field
  limits, and fixture coverage are grounded.
- The CDB working model now records `address + user` as the apparent entry key,
  with group, workspace, RoMON agent, and comments/notes treated as attributes.
- `CENTRS_PASSWORD`, `CENTRS_CDB_FILE`, `CENTRS_CDB_PASSWORD`, and
  `CENTRS_CDB_MODE` are captured as CDB/password-provider vocabulary to evaluate,
  not accepted S004 settings yet.
- WinBox UI terms such as "Saved", "Neighbors", "RoMON", "Save to list",
  "with password", "Remember password", "Workspace", "Open", "Move", "Import",
  "Export", and "Set file password" are captured as design alignment material
  for future device-management UX.
- The note's broader WinBox/Nova, terminal-over-WinBox, RoMON, L2 lab,
  dissector, and schema IR ideas have separate spike work items so this work item
  can remain the umbrella grounding checkpoint.

## Instruction gaps found

- RouterOS grounding instructions needed to cover `work/**` and `src/data/**`,
  not only protocol source and integration tests.
- The workflow docs needed to make evidence-backed work items the default for
  moderate protocol/data research.
- Specs needed a clearer rule that work items explain why a spec says something.

## Promotion status

- Durable instruction updates: done in this change.
- S006 refinements: done in this change, but S006 remains Draft.
- S002/S003 refinements: done in this change.
- Source implementation: not started.
- Tests: docs/instruction validation only.

## Remaining research backlog

- Pin Wireshark dissector source references for MNDP, MAC Telnet, RoMON, and
  WinBox.
- Extract packet/session notes from `/Users/amm0/Lab/Legacy/mac-telnet`.
- Define a safe macOS and Linux L2 lab topology for MNDP, MAC Telnet, and RoMON.
- Research WinBox CDB format/encryption/version drift and generate safe synthetic
  fixtures before any importer exists.
- Decide whether WinBox Terminal is an in-process adapter, external-tool launcher,
  or deferred non-goal.
- Decide whether CDB is canonical `centrs` storage, an import/export format, or
  one provider feeding a separate SQLite cache.
- Decide whether comments/notes metadata is safe enough for non-default protocol
  ports and other key/value attributes.
- Decide how non-RouterOS secrets such as SNMP communities can be represented
  without creating fake devices or silently exposing credentials.
