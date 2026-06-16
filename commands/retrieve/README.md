# retrieve

Read RouterOS state. RouterOS menu reads model `<path>/<verb>` where the verb
is `print`-style (`print`, `get`, and async POST-shaped reads as they're
added). SNMP reads use `retrieve <router> snmp <oid|MIB name>` and resolve
names through a MikroTik MIB cache downloaded from mikrotik.com.

> "POST-shaped reads" are RouterOS menu reads that require a request body
> (e.g. paged or query-driven `print`) and are therefore issued as REST `POST`
> rather than `GET`. centrs identifies them from the command tree and routes
> them accordingly as they're added.

Structured formats return an array of records, or — with `--attribute` — a
value or row of values wrapped in the standard envelope
(`docs/CONSTITUTION.md`). The default `text` format renders data and errors for
humans.

## Synopsis

```text
centrs retrieve <router> <path>[/<shortcut>] [flags]
centrs retrieve <router> snmp <oid|MIB name> [flags]
```

- `<router>` — IP, DNS, MAC, or CDB-resolved name. See constitution: identity.
- `<path>` — RouterOS path beginning with `/`, e.g. `/ip/address`. The verb is
  inferred (`print` for list paths, `get` for singletons like
  `/system/resource`). If the unnamed arg does not start with `/`, it is a
  reserved shortcut — currently none are defined; future examples include
  `defconf` → `/system/default-configuration/get`.
- Reading one row by name is **flag-only** (there is no row positional):
  `--query name=ether1` filters RouterOS rows and returns an **array**; the
  caller takes the match. `--query`/`--filter` always return an array — there is
  no singleton-by-name shape. (Decided: the old `<.id|name>` positional is
  dropped.)
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
| `--once`                            | Bounded single read of a monitor-style menu (RouterOS `once`): returns **one** envelope and never follows. Open-ended follow is the separate `stream` verb. See constitution: protocol selection. |
| `--query <expr>`                    | RouterOS-side **row** filter (maps to `.query`), repeatable; returns matching rows as an **array**. This is how you read one row by name (`--query name=ether1`). **Not Implemented** yet — returns `validation/not-implemented`. |
| `--filter <expr>`                   | RouterOS row filter; same `.query` mapping and not-implemented handling as `--query`.       |
| `--where <attr>=<value>`            | Device-class selector: fan out across CDB records whose stored fact/comment-kv matches (e.g. `--where board=RB5009`). Repeatable (AND). Filters *which devices*, not RouterOS rows. See constitution: target selection. |
| `--max-bytes <n>`                   | Byte budget for the rendered payload. If the response would exceed it, centrs truncates to fit, keeps `ok: true`, and adds a warning + `meta.truncated`. Not an error. (Renamed from `--max-results`; the legacy flag still parses until the code split lands.) |
| `--max-rows <n>`                    | Maximum row count for list reads. Excess rows are clipped; `ok: true` with a warning + `meta.truncated`.                                    |
| `--format text` (default)           | Human-readable rendering (default). Errors print `[code] summary` + `Fix:` lines. |
| `--format json` (alias `--json`)    | Structured JSON envelope (set `CENTRS_FORMAT=json` to make it the default).               |
| `--format yaml` (alias `--yaml`)    | YAML rendering of the same envelope.                                                      |
| `--resolve <none\|arp>`             | Resolve a MAC-address target to an IP via the host ARP cache. Default `none`.             |
| `--via <protocol>`                  | Pin the transport (`rest-api` default, or `native-api`). No silent downgrade. See constitution: protocol selection. |
| `--validate=false`                  | Escape hatch; default is `true`. See constitution: validation is the product.             |
| `--timeout <ms>`                    | Request timeout. REST: ≤ 60000. native-api allows longer.                                 |
| `--username` (alias `--user`, `-u`) / `--password` | Override CDB-resolved or env credentials.                                                 |
| `--host <host\|url>`                 | Override the resolved host or base URL for the target.                                     |
| `--port <n>`                        | Override the transport port. native-api defaults to 8728 (TLS api-ssl when `--port 8729`).|
| `--cdb-file` / `--cdb-password`     | Override CDB file location / decrypt password.                                            |
| `--ros-version <version>`           | SNMP MIB lookup only: pin the MikroTik MIB version to cache/download.                     |
| `--ros-channel <channel>`           | SNMP MIB lookup only: `stable`, `long-term`, `testing`, or `development`; default `stable`. |
| `--group <name>`                    | Fan out across every CDB target in WinBox group `<name>`. Repeatable, and combinable with `<router>` positionals plus `--all`/`--default`; the union is de-duped by CDB record index. See **Group fanout**. |
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

## SNMP MIB cache policy

Signed off (2026-06-06): cache MikroTik MIBs under the XDG cache root,
`${XDG_CACHE_HOME:-~/.cache}/tikoci/snmp-mibs`, not beside the CDB. The cache is
derived data; deleting it must never remove inventory or credentials. Use one
subdirectory per exact RouterOS version, for example
`routeros/7.23/mikrotik.mib`, plus metadata containing source URL, ETag,
Last-Modified, SHA-256, fetched-at, and the channel (if a channel resolved it).

Version selection for MIB-name lookup is deterministic. `--ros-version` wins and
downloads `https://download.mikrotik.com/routeros/<version>/mikrotik.mib`.
Otherwise `--ros-channel` (default `stable`) is resolved through
`https://upgrade.mikrotik.com/routeros/NEWESTa7.<channel>` and that exact version
is used. If target metadata already carries a RouterOS version from a trusted
source, it may supply the default version, but the SNMP path must not make an
extra REST/native call merely to discover a version.

Invalidation is by exact version plus HTTP validators. A missing version cache is
downloaded before lookup; an existing cache is reused offline. When online, a
cache older than 24h is revalidated with ETag/Last-Modified and replaced
atomically if MikroTik republishes the file. Channel pointers are short-lived:
re-resolve the channel after 24h, then use the cache for the resulting exact
version.

Offline behavior is intentionally conservative. Numeric OIDs do not require the
MIB cache and proceed normally. MIB-name lookup succeeds only when the selected
exact version is already cached; if not, fail before SNMP I/O with
`snmp/mib-cache-miss` and a fix that tells the caller to go online once or pass a
cached `--ros-version`. Do not silently fall back to a different version's MIB.

RouterOS grounding: MikroTik documents SNMP as retrieve/write-capable but centrs
uses it as retrieve-only; the same page points users to the MikroTik MIB download
surface. The per-version `mikrotik.mib` URL under `download.mikrotik.com` has
been verified for current stable/development versions, but treating it as the
long-term canonical URL is an assumption until the implementation has fallback
handling.

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

`--max-bytes` / `--max-rows` truncation populates
`meta.truncated = { returned, total, totalBytes }` and keeps `ok: true` with a
warning entry — it is not an error. (Earlier text said a byte overflow returns an
*error* with the needed size; superseded — truncation is an `ok: true` footnote so
partial data stays usable.)

## Group fanout

`--group <name>` loads the CDB once, expands every matching WinBox record in
that group, de-dupes by CDB record index, and runs the same per-target retrieve
pipeline for each target. Per the shared target-selector grammar, `--group` is
repeatable and combines freely with one or more `<router>` positionals, `--all`
(every CDB record), and `--default` (the `__default__` record); the union is
de-duped by CDB record index. (Earlier drafts made `--group` mutually exclusive
with a positional — superseded by the liberal selector model.)

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
- **tips** — when a `<router>` fails to resolve against an empty CDB, retrieve
  emits the same `tip/no-devices` advice as `devices list`, steering toward
  `centrs devices discover` and `centrs settings`.
