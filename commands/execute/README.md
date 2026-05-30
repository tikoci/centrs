# execute

Run a RouterOS CLI command and return its (semi-structured) output.

Status: `not-started`. This file is a stub. Promote to a full design when CDB
groups/fanout are grounded.

## Intent

- Mirror RouterOS `execute` semantics. Input is a CLI string; output is
  console-shaped text wrapped in the standard envelope.
- Validation runs through `:put [:parse "<cmd>"]` (via `/rest/parse`), not
  `/console/inspect`. Parse is the right tool for CLI-shaped commands.
- REST adapter calls `/rest/parse` then `/rest/execute`.
- Output is *string*-shaped; richer parsing is a future concern. The envelope
  must still distinguish RouterOS errors from successful runs (a 200 with a
  RouterOS error string is still an error — see constitution: error model).
- Protocol surfaces are REST/native API, SSH, mac-telnet, RoMON, and WinBox
  Terminal. SNMP is retrieve-only and must reject execute.
- For a MAC target not resolved from CDB, auto-selection defaults to
  mac-telnet. Callers that want IP-level execution may opt into ARP-based
  MAC → IP resolution before protocol selection.
- CDB comment-kv metadata may provide per-target `via` and `port` overrides;
  CLI/API arguments still win.
- RoMON and WinBox Terminal are lower priority than mac-telnet until their
  validation, tooling, and CI story are grounded.

## Open shape questions

- How to expose multi-line / async / progress output without committing to a
  single-shot model up front.
- Whether `--strict` should reject "succeeded with stderr-like content."
- How SSH key paths/material are represented across CDB metadata, env, CLI,
  and redaction.

Defer until CDB groups/fanout have settled the multi-target envelope.
