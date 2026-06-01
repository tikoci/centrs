# mcp — examples

Each numbered example is an executable spec for the MCP surface. The integration
test `test/integration/mcp.test.ts` boots a CHR 7.23 router with
`@tikoci/quickchr`, registers it in a throwaway CDB, starts the centrs MCP server
over stdio, and drives it with an in-process MCP client. Each example below maps
to one assertion. If a line here is not exercised by a test, the test file is
wrong; if a line passes only with `validate=false`, the **implementation** is
wrong (see `docs/CONSTITUTION.md`).

These examples are MCP **tool calls** (JSON `params.arguments`), not shell
commands. `$NAME` is the CDB name the harness assigns the booted CHR; `$U` / `$P`
are CHR credentials stored in the CDB record (never passed inline). The result is
the standard centrs envelope returned as the tool's JSON text content.

## Phase 1 — read + validate (stdio)

### 1. `centrs_explain` canonicalizes offline (no CDB, no device)

```json
{ "name": "centrs_explain",
  "arguments": { "command": "/ip/route/add dst-address=10.99.0.0/24 blackhole=yes" } }
```

Envelope: `ok: true`, `data.path = "/ip/route"`, `data.verb = "add"`,
`data.mode = "structured"`, `data.writeShaped = true`, `data.args` includes
`dst-address` and `blackhole`. No network or CDB access occurs.

### 2. Unregistered target is rejected (CDB is the allowlist)

```json
{ "name": "centrs_retrieve",
  "arguments": { "target": "192.0.2.1", "path": "/system/resource" } }
```

Envelope: `ok: false`, `error.code = "cdb/target-not-registered"`, and
`error.fix`/`remediation` names `centrs_devices add`. No connection is attempted.
The MCP tools accept only a CDB `target` (name/MAC/URL) — there is no inline
`host`/`username`/`password` parameter, so credentials never pass through the
agent.

### 3. `centrs_validate` accepts the bare `blackhole` flag

```json
{ "name": "centrs_validate",
  "arguments": { "target": "$NAME",
                 "command": "/ip/route/add dst-address=10.99.0.0/24 blackhole" } }
```

Envelope: `ok: true`, `meta.validation.source` includes `:put [:parse]` (the
RouterOS parser accepted the bare flag), and **no route is created** (dry-run
only — a follow-up `centrs_retrieve` of `/ip/route` shows no `10.99.0.0/24`). A
bare flag like `blackhole` routes through script-mode `:parse`, so the
`/console/inspect` semantic gate does not apply here — `:parse` is the gate that
matters for the bench gold-bug in example 4.

### 4. `centrs_validate` rejects a schema-invalid command (the dual gate)

```json
{ "name": "centrs_validate",
  "arguments": { "target": "$NAME",
                 "command": "/ip/route/add dst-address=10.99.0.0/24 nonexistentattr=1" } }
```

Envelope: `ok: false`, `error.code = "validation/unknown-attribute"` — the
`/console/inspect` semantic gate rejects the unknown attribute and **no route is
created**. This proves the validate tool fails closed on bad input.

> Bench note: the bench's original gold-bug command
> `/ip/route/add dst-address=10.99.0.0/24 blackhole=yes` (where `/console/inspect`
> accepted a value the console `:parse` rejected) does **not** reproduce on
> RouterOS 7.23 — the device parser now accepts `blackhole=yes`. centrs still runs
> **both** gates (`:parse` + `/console/inspect`) so the stricter of the two wins
> whenever a version does reject it; this example asserts the still-true,
> version-robust behavior (unknown-attribute rejection) instead.

### 5. `centrs_retrieve` returns structured records

```json
{ "name": "centrs_retrieve",
  "arguments": { "target": "$NAME", "path": "/system/resource",
                 "attributes": ["version", "board-name"] } }
```

Envelope: `ok: true`, `data` is a single object carrying `version` and
`board-name` (the `/system/resource` menu is a single record, not a list),
`meta.via = "rest-api"`.

### 6. `centrs_execute` runs a read-shaped command

```json
{ "name": "centrs_execute",
  "arguments": { "target": "$NAME", "command": "/system/identity/print" } }
```

Envelope: `ok: true`, `meta.operation.request.write = false`, and
`meta.validation` shows the parse gate ran.

## CHR-verified gated writes

### 7. Write against an `mcp=ro` target is refused

With `$NAME` registered `mcp=ro` (default):

```json
{ "name": "centrs_execute",
  "arguments": { "target": "$NAME",
                 "command": "/ip/address/add address=198.51.100.10/32 interface=ether1",
                 "confirm": true } }
```

Envelope: `ok: false`, `error.code = "cdb/write-not-permitted"`. The router is not
mutated even though `confirm` is true — the CDB policy is authoritative.

### 8. Write against an `mcp=rw` target succeeds with `confirm: true`

With `$NAME` registered `mcp=rw`:

```json
{ "name": "centrs_execute",
  "arguments": { "target": "$NAME",
                 "command": "/ip/address/add address=198.51.100.10/32 interface=ether1 comment=centrs-mcp",
                 "confirm": true } }
```

Envelope: `ok: true`, `data.ret` matches `/^\*[0-9A-F]+$/`,
`meta.operation.request.write = true`, `meta.validation.source` includes both
`:parse` and `/console/inspect`.

### 9. Write without `confirm` on an `mcp=rw` target fails closed

```json
{ "name": "centrs_execute",
  "arguments": { "target": "$NAME",
                 "command": "/ip/address/remove [find comment=centrs-mcp]" } }
```

Envelope: `ok: false`, `error.code = "usage/confirmation-required"`; the address
added in example 8 still exists. (Cleanup runs with `confirm: true`.)

## Phase 2 candidate — CDB mutations

### 10. `centrs_devices add` grows the allowlist in-band

```json
{ "name": "centrs_devices",
  "arguments": { "op": "add", "name": "lab-edge", "host": "203.0.113.4",
                 "username": "$U", "password": "$P", "mcp": "rw" } }
```

Envelope: `ok: true`, the CDB now resolves `lab-edge`, and a subsequent
`centrs_retrieve` against `lab-edge` no longer returns
`cdb/target-not-registered`. (Uses the throwaway CDB; no real device contacted.)

This example is **not implemented or CHR-passed yet**. Phase 1 exposes
`centrs_devices` as read-only (`list`/`show`/`groups`) and keeps all target
registration outside the MCP tool surface.
