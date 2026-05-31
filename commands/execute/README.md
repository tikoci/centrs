# execute

Run a RouterOS CLI command and return its (semi-structured) output. `execute`
is the single read/write surface for RouterOS add/set/remove and other
CLI-shaped commands — there is no separate `update` command.

Status: `not-started`. This file is a stub. Promote to a full design when CDB
groups/fanout are grounded.

## Intent

- Mirror RouterOS `execute` semantics. Input is a CLI string; output is
  console-shaped text (or structured records for path+verb writes) wrapped in
  the standard envelope. This includes write-shaped add/set/remove.
- Validation is two-stage (see constitution: validation): `:put [:parse
  "<cmd>"]` is a **syntax** gate only — it does not catch unknown attributes or
  bad values. Semantic validation needs `/console/inspect` or the server's own
  re-validation on the write round-trip. A clean parse is necessary, not
  sufficient.
- REST adapter prefers structured path-POST when the CLI canonicalizes to
  path+verb+attrs (`POST /rest/<path>/<verb>` → `{"ret":"<.id>"}`, clean typed
  errors); falls back to `POST /rest/execute {"script":"<cli>"}` for
  non-path-shaped console commands.
- native-api adapter issues the same write as a tagged `talk` sentence; its
  `!trap` strings share one error table with REST `detail`.
- Output is *string*-shaped for script-mode; richer parsing is a future
  concern. The envelope must still distinguish RouterOS errors from successful
  runs (a 200 with a RouterOS error string is still an error — see
  constitution: error model).
- Protocol surfaces are native API, REST, and mac-telnet (preferred order);
  SSH, RoMON, and WinBox Terminal are later. SNMP is retrieve-only and must
  reject execute.
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
