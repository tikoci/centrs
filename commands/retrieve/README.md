# retrieve

Read RouterOS state. Models `<path>/<verb>` where the verb is `print`-style
(`print`, `get`, and async POST-shaped reads as they're added).

> TODO: "POST-shaped reads" need to be identified from

Returns an array of records, or — with `--attribute` — a value or row of
values, all wrapped in the standard envelope (`docs/CONSTITUTION.md`).

## Synopsis

```text
centrs retrieve <router> <path>[/<shortcut>] [<.id|name>] [flags]
```

- `<router>` — IP, DNS, MAC, or CDB-resolved name. See constitution: identity.
- `<path>` — RouterOS path beginning with `/`, e.g. `/ip/address`. The verb is
  inferred (`print` for list paths, `get` for singletons like
  `/system/resource`). If the unnamed arg does not start with `/`, it is a
  reserved shortcut — currently none are defined; future examples include
  `defconf` → `/system/default-configuration/get`.
- `<.id|name>` — optional row selector for menus that have rows.

## Flags

| Flag                                | Behavior                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `--attribute <name>`                | Project a single attribute. Repeatable, or comma-separated.                               |
| `--attributes <a,b,c>`              | Alias for `--attribute` with comma-separated input.                                       |
| `--all-attributes`                  | Equivalent to RouterOS `details=true`. Mutually exclusive with `--attribute(s)`.          |
| `--list-attributes` (alias `--list`) | Return the available attribute names for the path. No `print`/`get` is run.              |
| `--query <q>`                       | **Not Implemented.** Surface the flag; return `validation/not-implemented` until specced. |
| `--filter <q>`                      | **Not Implemented.** Same handling as `--query`. RouterOS `.query` mapping is TBD.        |
| `--max-results <bytes>`             | If response would exceed the limit, return error with object count + total size needed.   |
| `--format json` (alias `--json`)    | JSON envelope (default for non-tty).                                                      |
| `--format yaml` (alias `--yaml`)    | YAML rendering of the same envelope.                                                      |
| `--via <protocol>`                  | Pin the transport. No silent downgrade. See constitution: protocol selection.             |
| `--validate=false`                  | Escape hatch; default is `true`. See constitution: validation is the product.             |
| `--timeout <ms>`                    | Request timeout. REST: ≤ 60000.                                                           |
| `--username` / `--password`         | Override CDB-resolved or env credentials.                                                 |
| `--cdb-file` / `--cdb-password`     | Override CDB file location / decrypt password.                                            |

## Validation

Default validator: `/console/inspect request=syntax path=<comma-joined>,print`
(or `,get` for singleton paths). Validator must reject unknown paths and
unknown attributes with `validation/*` codes that include the inspect-suggested
alternatives in the error envelope.

If `--all-attributes` is combined with `--attribute(s)`, fail with
`usage/conflicting-flags` *before* hitting the network.

## Output shape

```ts
{
  ok: true,
  data: [ { ".id": "*1", address: "192.0.2.1/24", ... }, ... ],   // array of rows
  // or for singletons (e.g. /system/resource):
  // data: { uptime: "...", "cpu-load": 7, ... },
  // or for --attribute:
  // data: "192.0.2.1/24",       // single value
  meta: { target, via, settings, validation, timing }
}
```

`--max-results` truncation populates `meta.truncated = { returned, total, totalBytes }`
and keeps `ok: true` with a warning entry — it is not an error.

## Definition of done

This command is `CHR-passed` only when every line in `examples.md` runs green
against a real CHR through `bun run test:integration`. Disabling validation to
reach green is forbidden. See `docs/CONSTITUTION.md` for the full done rule.

## Notes for future cells

- **native-api** — preferred long-term for retrieve. Adapter contract will be
  formalized when the second transport lands; do not pre-generalize from REST
  alone.
- **ssh** — only relevant for `retrieve` if we later want CLI-shaped print
  output as a fallback. Not on the roadmap yet.
- **mac-telnet** — could carry retrieve over L2 once the protocol is well
  understood; currently scoped to terminal/execute.
