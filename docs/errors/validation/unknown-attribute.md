# `validation/unknown-attribute`

An attribute is not valid for the path/verb per /console/inspect. The
validator rejects the command before RouterOS executes it.

## Context keys

Context keys vary by validation mechanism — callers must not assume every
key below is present on every `validation/unknown-attribute` rejection.
The inspect-gated paths (`/console/inspect` + `:parse`) emit the full
structured shape; the console `:parse`-only path emits a lighter shape.

| Key | Type | Notes |
| --- | ---- | ----- |
| `parameter` | `string` | Offending attribute name — `missing[0]` (first missing). Always present on the inspect-gated `validation/unknown-attribute` path; console `:parse` siblings use `command`/`detail`/`position` instead. |
| `requestedAttributes` | `string[]` | Full requested attribute/argument list supplied by the caller. Inspect-gated only. |
| `availableAttributes` | `string[]` | Attributes the path/verb exposes per `/console/inspect`. Inspect-gated only. |
| `path` | `string` | Slash-prefixed RouterOS path (e.g. `/ip/address`). Inspect-gated only. |
| `verb` | `string` | Verb when applicable (`print`, `add`, `set`, …). Absent on retrieve (path-only). Inspect-gated only. |
| `validationSource` | `string` | Inspect provenance (e.g. `/console/inspect request=child+completion`, `:put [:parse] + /console/inspect`). Inspect-gated only. |

Provenance:

- `src/api.ts:988,1033` — REST/native `validateApiRequest` (print vs add/set branches)
- `src/execute.ts:742` — REST `validateRestExecute`
- `src/retrieve.ts:233` — REST `retrieve` attribute projection
- `src/protocols/mac-telnet-console.ts:674` — console `:parse` (`bad parameter <name>`) over mac-telnet/ssh
- `src/core/routeros-errors.ts:128` — `!trap`/`detail` `unknown parameter <name>` (routeros/unknown-attribute sibling)

## Fix

Check the attribute name against `/console/inspect`, or use
`--list-attributes` to inspect the available properties first. Use
`--validate=false` only when intentionally probing an undocumented
RouterOS edge.
