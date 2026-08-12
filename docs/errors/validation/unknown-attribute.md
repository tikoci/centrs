# `validation/unknown-attribute`

An attribute or argument is not valid for the requested RouterOS operation.
The validator rejects the request before RouterOS executes it.

## Context keys

Context keys vary by validation mechanism. Callers must not assume every key
below is present on every `validation/unknown-attribute` rejection.

| Key | Type | Notes |
| --- | ---- | ----- |
| `parameter` | `string` | First offending name. Present on retrieve and inspect-gated rejections, and on console `:parse` when RouterOS reports `bad parameter <name>`. |
| `requestedAttributes` | `string[]` | Full requested name list. Retrieve and inspect-gated API/execute validation only. |
| `availableAttributes` | `string[]` | Names exposed for the path/verb. Retrieve and inspect-gated API/execute validation only. |
| `path` | `string` | Slash-prefixed RouterOS path (for example `/ip/address`). Retrieve and inspect-gated API/execute validation only. |
| `verb` | `string` | Verb when applicable (`print`, `add`, `set`, …). Inspect-gated API/execute validation only; retrieve is path-only. |
| `validationSource` | `string` | Validation provenance. Inspect-gated API/execute and console `:parse` only; retrieve does not currently emit it. |
| `command` | `string` | Original CLI command. Console `:parse` only. |
| `detail` | `string` | Raw RouterOS parse diagnostic. Console `:parse` only. |

Console `:parse` may also put RouterOS' byte location in the top-level
`error.position` field. On older RouterOS versions, an unknown name can produce
only a generic syntax diagnostic; that is reported as `validation/syntax`
because no parameter identity is available.

Provenance:

- `src/api.ts:988,1033` — REST/native `validateApiRequest` (print vs add/set branches)
- `src/execute.ts:742` — REST `validateRestExecute`
- `src/retrieve.ts:233` — REST `retrieve` attribute projection
- `src/protocols/mac-telnet-console.ts:674` — console `:parse` (`bad parameter <name>`) over mac-telnet/ssh
- `src/core/routeros-errors.ts:128` — `!trap`/`detail` `unknown parameter <name>` (routeros/unknown-attribute sibling)

## Fix

Check the name against `/console/inspect`. For `retrieve`, use
`--list-attributes` to inspect available properties first. Use
`--validate=false` only when intentionally probing an undocumented RouterOS
edge.
