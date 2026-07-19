# retrieve — examples

Each numbered example is an executable spec. The integration test under
`test/integration/rest-retrieve.test.ts` runs every example against a CHR
booted by `@tikoci/quickchr`. If a line here is not exercised by a test, the
test file is wrong; if a line passes only with `validate=false`, the
**implementation** is wrong (see `docs/CONSTITUTION.md`).

`$R` is `<host>:<rest-port>` resolved by quickchr.
`$U` / `$P` are CHR credentials provided by the test harness.
Examples that assert envelope fields pass `--json`; plain text is the default
for human CLI use.

## Singletons (read a single record)

### 1. /system/resource

Must succeed with `validate=true` (default).

```bash
centrs retrieve $R /system/resource --username $U --password $P --json
```

Envelope: `ok: true`, `data` is an object, `meta.via=rest-api`,
`meta.validation.source=/console/inspect`.

### 2. /system/identity

Same shape, different menu.

```bash
centrs retrieve $R /system/identity --username $U --password $P --json
```

## Lists (read an array of rows)

### 3. /ip/address

Empty or populated, both must succeed with `validate=true`.

```bash
centrs retrieve $R /ip/address --username $U --password $P --json
```

Envelope: `ok: true`, `data` is an array.

### 4. /interface

List of interfaces present on a default CHR.

```bash
centrs retrieve $R /interface --username $U --password $P --json
```

## Attribute projection

### 5. Single --attribute on a singleton

```bash
centrs retrieve $R /system/resource --attribute uptime --username $U --password $P --json
```

Envelope: `data` is the bare value, not an object.

### 6. Comma-list --attributes on a list

```bash
centrs retrieve $R /interface --attributes name,type --username $U --password $P --json
```

Envelope: `data` is an array of objects each containing only `name` and `type`.

### 7. --all-attributes (RouterOS details=true)

```bash
centrs retrieve $R /system/resource --all-attributes --username $U --password $P --json
```

### 8. Conflict: --attribute + --all-attributes

Rejected before any network call, with `usage/conflicting-flags`.

```bash
centrs retrieve $R /system/resource --attribute uptime --all-attributes --username $U --password $P --json
```

## --list-attributes

### 9. List attributes for a path

Without running `print`/`get`.

```bash
centrs retrieve $R /system/resource --list-attributes --username $U --password $P --json
```

Envelope: `data` is `string[]`. No `meta.timing.request` (no transport call).

## Validation surface

### 10. Unknown path

Must fail with `validation/unknown-path` (not `routeros/unsupported-path`
from a server round-trip; the validator catches it first). The error
envelope must include suggested alternatives from `/console/inspect` when
available.

```bash
centrs retrieve $R /not/a/real/path --username $U --password $P --json
```

### 11. Unknown attribute

`validation/unknown-attribute` with suggestions.

```bash
centrs retrieve $R /system/resource --attribute bogus --username $U --password $P --json
```

## Transport / error contract

### 12. Bad credentials

`transport/auth-failed`, `details_url` populated.

```bash
centrs retrieve $R /system/resource --username wrong --password wrong --json
```

### 13. Unreachable host

`transport/connection-refused` (not the more general `transport/network`).

```bash
centrs retrieve 127.0.0.1:1 /system/resource --username $U --password $P --json
```

### 14. REST timeout ceiling

`--timeout 70000` against `--via rest-api` is rejected up front with
`usage/timeout-out-of-range` (REST hard cap is 60s).

```bash
centrs retrieve $R /system/resource --via rest-api --timeout 70000 --username $U --password $P --json
```

## CDB resolution

### 15. Name resolution

`<router>` matches a CDB-stored target; user/password are filled from CDB.

```bash
centrs retrieve $R /system/resource --cdb-file $CDB --json
```

### 16. Unused --cdb-password on an unencrypted CDB

Call succeeds with a `cdb/password-not-needed` warning in `meta.warnings`.

```bash
centrs retrieve $R /system/resource --cdb-file $CDB --cdb-password ignored --json
```

## Target selection (fan-out)

These exercise the shared target-selection grammar
([`docs/CONSTITUTION.md` → Target selection grammar](../../docs/CONSTITUTION.md#target-selection-grammar)).
`test/integration/fanout-retrieve.test.ts` runs them when CHR integration is
enabled. `$CDB` contains two records in group `fanout-chr`: record 0 is the live
CHR (comment fact `role=edge`) and record 1 is an unreachable REST URL (comment
fact `role=core`).

### F1. Group fan-out with one inner success and one inner failure

```bash
centrs retrieve --group fanout-chr /system/resource --cdb-file $CDB --json
```

Outer envelope: `ok: true`, `data.summary = { total: 2, ok: 1, failed: 1 }`,
`data.targets` is ordered by CDB `recordIndex`, and `meta.operation.kind` is
`fanout`. The unreachable target is an inner `ok: false` envelope with
`transport/connection-refused`. Process exit `2` (partial).

### F2. Empty / unknown group

```bash
centrs retrieve --group no-such-group /system/resource --cdb-file $CDB --json
```

Envelope: `ok: true`, `data.summary = { total: 0, ok: 0, failed: 0 }`,
`data.targets = []`, and warnings include `cdb/empty-group`. Exit `0`.

### F3. `--where` device-class selector (subset)

```bash
centrs retrieve --where role=edge /system/resource --cdb-file $CDB --json
```

`--where` matches the raw comment fact, selecting only record 0:
`data.summary = { total: 1, ok: 1, failed: 0 }`,
`meta.operation.selection.where = ["role=edge"]`, exit `0`.

### F4. `--all` (every CDB record)

```bash
centrs retrieve --all /system/resource --cdb-file $CDB --json
```

`--all` fans across every record (excluding `__default__`) — here both, so
`data.summary = { total: 2, ok: 1, failed: 1 }`,
`meta.operation.selection.all = true`, exit `2`.

### F5. Multiple positional targets (ad-hoc literals)

```bash
centrs retrieve $REACHABLE_URL $UNREACHABLE_URL /system/resource --username $U --password $P --json
```

More than one positional target is fan-out mode without any selector flag. With
no `--cdb-file`, both are ad-hoc literals, labeled by `meta.target.input` with no
`recordIndex`: `data.summary = { total: 2, ok: 1, failed: 1 }`, exit `2`.

## Format

### 17. --format yaml

`text` is the default; `--json` (or `--format json`) emits the structured
envelope, and `--format yaml` renders the same envelope. The two structured
outputs round-trip to the same JS value.

```bash
centrs retrieve $R /system/resource --format yaml --username $U --password $P
```

## Out-of-scope (must surface as not-implemented)

### 18. --query

Returns `validation/not-implemented` immediately.

```bash
centrs retrieve $R /ip/address --query 'address~"192"' --username $U --password $P --json
```

### 19. --filter

Same handling as `--query`.

```bash
centrs retrieve $R /ip/address --filter 'disabled=no' --username $U --password $P --json
```

## native-api (`--via native-api`)

The same retrieve contract over the RouterOS binary API (TCP 8728, or TLS 8729
when `--port 8729`). `$A` is `<host>` and `--port` is the resolved api port
from quickchr (`chr.ports.api`). Validation still runs through
`/console/inspect`, issued as a native-API command rather than over REST.

These are exercised by `test/integration/native-api-retrieve.test.ts`.

One transport-specific note: native-API attribute values are **strings**
(the binary API does not carry JSON scalar types), so `data` scalars are
strings even where the REST path returns a number/boolean. The envelope shape
(object vs array vs bare value, projection, validation source) is identical.

### N1. Singleton over native-api

```bash
centrs retrieve $A /system/resource --via native-api --port $API_PORT --username $U --password $P
```

Envelope: `ok: true`, `data` is an object, `meta.via=native-api`,
`meta.validation.source` contains `/console/inspect`.

### N2. Second singleton

```bash
centrs retrieve $A /system/identity --via native-api --port $API_PORT --username $U --password $P
```

### N3. List menu → array

```bash
centrs retrieve $A /interface --via native-api --port $API_PORT --username $U --password $P
```

### N4. Possibly-empty list

```bash
centrs retrieve $A /ip/address --via native-api --port $API_PORT --username $U --password $P
```

### N5. Singleton single `--attribute` → bare value

```bash
centrs retrieve $A /system/resource --attribute uptime --via native-api --port $API_PORT --username $U --password $P
```

### N6. List `--attributes` projection

```bash
centrs retrieve $A /interface --attributes name,type --via native-api --port $API_PORT --username $U --password $P
```

`data` is an array of objects each containing only `name` and `type`.

### N7. `--all-attributes` (native `print detail`)

```bash
centrs retrieve $A /system/resource --all-attributes --via native-api --port $API_PORT --username $U --password $P
```

### N8. `--list-attributes` (inspect only, no data call)

```bash
centrs retrieve $A /system/resource --list-attributes --via native-api --port $API_PORT --username $U --password $P
```

### N9. Unknown path → `validation/unknown-path`

```bash
centrs retrieve $A /not/a/real/path --via native-api --port $API_PORT --username $U --password $P
```

### N10. Unknown attribute → `validation/unknown-attribute`

```bash
centrs retrieve $A /system/resource --attribute bogus-attr --via native-api --port $API_PORT --username $U --password $P
```

### N11. Bad credentials → `transport/auth-failed`

```bash
centrs retrieve $A /system/resource --via native-api --port $API_PORT --username wrong --password wrong
```

## quickchr targets (#134)

`$NAME` is the machine name of a running quickchr-managed CHR
(`quickchr list`). No `$R`/`$U`/`$P` — host/port/auth come from the live
descriptor. Covered by `test/integration/quickchr-target.test.ts`.

### Q1. `--quickchr <name>` resolves the VM's REST endpoint

```bash
centrs retrieve --quickchr $NAME /system/resource --json
```

Envelope: `ok: true`, `meta.via=rest-api` (normal default; quickchr does not
change protocol selection), `meta.target.source.kind=provider`,
`meta.target.identity=$NAME`, no `recordIndex` (the CDB was never consulted).
