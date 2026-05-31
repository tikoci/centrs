# retrieve

Read RouterOS state. RouterOS menu reads model `<path>/<verb>` where the verb
is `print`-style (`print`, `get`, and async POST-shaped reads as they're
added). SNMP reads use `retrieve <router> snmp <oid|MIB name>` and resolve
names through a MikroTik MIB cache downloaded from mikrotik.com.

> "POST-shaped reads" are RouterOS menu reads that require a request body
> (e.g. paged or query-driven `print`) and are therefore issued as REST `POST`
> rather than `GET`. centrs identifies them from the command tree and routes
> them accordingly as they're added.

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
| `--group <name>`                    | Fan out across every CDB target in WinBox group `<name>`. Mutually exclusive with a `<router>` positional. See **Group fanout**. |
| `--concurrency <n>`                 | Max in-flight targets during fanout (integer ≥ 1). Defaults are transport-aware: `rest-api` 8, `native-api` 4. Rejected with `usage/invalid-concurrency` otherwise. |

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

## Group fanout

`--group <name>` loads the CDB once, expands every matching WinBox record in
that group, de-dupes by CDB record index, and runs the same per-target retrieve
pipeline for each target. `--group` replaces the `<router>` positional and is
invalid with a separate router argument.

Fanout output is one outer envelope whose `ok` reports orchestration success:
`ok: false` is reserved for failures before reliable per-target results exist
(for example invalid flags or CDB decrypt failure). Per-target success/failure
is data, not metadata:

```ts
{
  ok: true,
  data: {
    summary: { total: 2, ok: 1, failed: 1 },
    targets: [
      { ok: true, data: { ... }, meta: { target: { recordIndex: 0 }, ... } },
      { ok: false, error: { code: "transport/connection-refused", ... }, meta: { target: { recordIndex: 1 }, ... } }
    ]
  },
  warnings: [],
  meta: {
    target: {},
    via: "rest-api", // null if inner targets disagree on protocol
    settings: { ... },
    operation: {
      kind: "fanout",
      group: "prod-edge",
      concurrency: 8,
      summary: { total: 2, ok: 1, failed: 1 },
      request: { path: "/system/resource", validate: true, format: "json", ... }
    }
  }
}
```

An empty or unknown group is `ok: true` with
`data.summary = { total: 0, ok: 0, failed: 0 }`, `data.targets = []`, and a
`cdb/empty-group` warning. Validation runs per target because RouterOS schemas
can differ by version. Fanout retries each target up to two times only for
`transport/network` and `transport/connection-closed`; REST 5xx failures are
mapped to `transport/connection-closed`. It does not retry `routeros/*`,
`validation/*`, `auth/*`, `cdb/*`, `target/*`, timeouts, DNS, TLS, or refused
connections.

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
