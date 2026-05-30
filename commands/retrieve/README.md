# retrieve

Read RouterOS state. RouterOS menu reads model `<path>/<verb>` where the verb
is `print`-style (`print`, `get`, and async POST-shaped reads as they're
added). SNMP reads use `retrieve <router> snmp <oid|MIB name>` and resolve
names through a MikroTik MIB cache downloaded from mikrotik.com.

> TODO: "POST-shaped reads" need to be identified from

Returns an array of records, or — with `--attribute` — a value or row of
values, all wrapped in the standard envelope (`docs/CONSTITUTION.md`).

## Synopsis

```text
centrs retrieve <router> <path>[/<shortcut>] [<.id|name>] [flags]
centrs retrieve <router> snmp <oid|MIB name> [flags]
```

- `<router>` — IP, DNS, MAC, or CDB-resolved name. See constitution: identity.
- `<path>` — RouterOS path beginning with `/`, e.g. `/ip/address`. The verb is
  inferred (`print` for list paths, `get` for singletons like
  `/system/resource`). If the unnamed arg does not start with `/`, it is a
  reserved shortcut — currently none are defined; future examples include
  `defconf` → `/system/default-configuration/get`.
- `<.id|name>` — optional row selector for menus that have rows.
- `snmp <oid|MIB name>` — planned retrieve-only SNMP form. OIDs are used
  directly; MIB names are resolved from the cached MikroTik MIB that matches
  the selected RouterOS version/channel once that cache is implemented.

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
| `--via <protocol>`                  | Pin the transport (`rest-api` default, or `native-api`). No silent downgrade. See constitution: protocol selection. |
| `--validate=false`                  | Escape hatch; default is `true`. See constitution: validation is the product.             |
| `--timeout <ms>`                    | Request timeout. REST: ≤ 60000. native-api allows longer.                                 |
| `--username` / `--password`         | Override CDB-resolved or env credentials.                                                 |
| `--port <n>`                        | Override the transport port. native-api defaults to 8728 (TLS api-ssl when `--port 8729`).|
| `--cdb-file` / `--cdb-password`     | Override CDB file location / decrypt password.                                            |

## Validation

Default validator: `/console/inspect request=syntax path=<comma-joined>,print`
(or `,get` for singleton paths). Validator must reject unknown paths and
unknown attributes with `validation/*` codes that include the inspect-suggested
alternatives in the error envelope.

If `--all-attributes` is combined with `--attribute(s)`, fail with
`usage/conflicting-flags` *before* hitting the network.

SNMP validation is separate from RouterOS `/console/inspect`: OIDs and MIB
names must resolve through the MIB cache before any SNMP request is sent.

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

- **native-api** — implemented for retrieve (`--via native-api`, `CHR-passed`;
  see `examples.md` N1–N11 and `test/integration/native-api-retrieve.test.ts`).
  Validation still runs through `/console/inspect` (issued as a native-API
  command). Attribute values arrive as strings because the binary API carries
  no JSON scalar types; the envelope shape is otherwise identical to REST.
- **snmp** — retrieve-only OID/MIB reads. It does not validate through
  `/console/inspect` and does not execute RouterOS CLI.
- **ssh / mac-telnet / romon / winbox-terminal** — execute surfaces, not
  retrieve surfaces.
