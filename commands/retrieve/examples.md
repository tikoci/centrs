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

### 20. Comma-list --attributes on any singleton

Singletons are recognized from `/console/inspect` — their `get` takes no
`number` argument — so every singleton validates against its `get value-name`
properties, not against `print`'s flags (#377).

```bash
centrs retrieve $R /tool/romon --attributes enabled,id --username $U --password $P --json
```

Envelope: `data` is an object containing only `enabled` and `id`.

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

## Row filters

### 18. --query with a regex

A regex has no RouterOS API query word, so it fails
`input/unsupported-query` before anything is read. The full `--query`
contract is in the **Query** section below.

```bash
centrs retrieve $R /ip/address --query 'address~"192"' --username $U --password $P --json
```

### 19. --filter

`--filter` is `--query`: the router filters, and every returned row matches.

```bash
centrs retrieve $R /interface --filter 'type=ether' --username $U --password $P --json
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

### N12. Singleton `--attributes` projection (#377)

```bash
centrs retrieve $A /tool/romon --attributes enabled,id --via native-api --port $API_PORT --username $U --password $P
```

`data` is an object containing only `enabled` and `id`.

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

## Follow (`--follow`, #396)

Contract: [README → Follow](README.md#follow---follow). `$A`/`$API_PORT` as in
the native-api section; `--via` is left unset because `--follow` infers
native-api. Covered by `test/integration/retrieve-follow.test.ts`; the engine
orderings a CHR cannot produce on demand (A1 replay, the sweep's
changed-since-sent exclusion, overflow) are pinned in
`test/unit/retrieve-follow.test.ts`.

### FL1. Bootstrap: snapshot frames, one `synced`, a summary

```bash
centrs retrieve $A /ip/address --follow --duration 3s --port $API_PORT --username $U --password $P --json
```

Every line parses as an envelope. Frames before `synced` have
`phase: "snapshot"` and `source: "print"`; exactly one `synced`; the last line
is the summary with `stopReason: "duration-elapsed"`, `synced: true`,
`changes: 0`. Every frame carries `meta.operation.stream.id`.

### FL2. A live change, and `--count` that ignores the snapshot

```bash
centrs retrieve $A /ip/address --follow --count 1 --duration 15s --port $API_PORT --username $U --password $P --json
```

After `synced`, add an address. The follow ends with `stopReason:
"count-reached"` after exactly one `live` `upsert` frame from `listen`, however
many snapshot frames came first.

### FL3. A removal RouterOS sends

```bash
centrs retrieve $A /ip/address --follow --sweep 0 --count 1 --duration 15s --port $API_PORT --username $U --password $P --json
```

After `synced`, remove an address that existed before the follow. One `live`
`removed` frame, `source: "listen"`, `data: null`. `--sweep 0` keeps the sweep
out of the race, and its `tip/follow-sweep-off` notice is the first line.

### FL4. A removal RouterOS does not send (view menu → sweep)

```bash
centrs retrieve $A /interface/bridge --follow --sweep 1s --duration 15s --port $API_PORT --username $U --password $P --json
```

Create a bridge after `synced`, then remove it. Its `upsert` comes from
`listen`; its removal comes from the sweep (`source: "sweep"`), because
`/interface/<type>` never sends `.dead`.

### FL5. `--attributes` projects `data`, identity stays in meta

```bash
centrs retrieve $A /ip/address --follow --attributes address --duration 3s --port $API_PORT --username $U --password $P --json
```

Every snapshot frame's `data` has only `address`; `meta.operation.stream.id`
still names the row.

### FL6. A menu RouterOS cannot follow

```bash
centrs retrieve $A /system/resource --follow --port $API_PORT --username $U --password $P --json
```

One envelope: `ok: false`, `validation/not-followable`, exit 1. No summary.

### FL7. A pinned REST transport

```bash
centrs retrieve $R /ip/address --via rest-api --follow --username $U --password $P --json
```

One envelope: `ok: false`, `transport/capability-unsupported`. No polling
fallback.

### FL8. NDJSON is readable before the process exits; Ctrl-C ends it cleanly

```bash
centrs retrieve $A /ip/address --follow --format ndjson --port $API_PORT --username $U --password $P
```

Run as a subprocess. The first frame line parses while the process is still
running; after `SIGINT` the last line is a successful summary with
`stopReason: "interrupted"`, and the exit code is 0.

### FL9. A1 and the sweep under churn (regression harness)

```bash
centrs retrieve $A /ip/firewall/address-list --follow --sweep 200ms --duration 8s --port $API_PORT --username $U --password $P --json
```

A second connection updates, adds and removes address-list rows while the
follow bootstraps and runs. Applying every line in order must equal a fresh
`print` taken after the churn settles: no stale value, no resurrected row, no
row removed by a sweep while it still exists. #396 round 3 measured 0 errors
over about 14.7k writes with this bootstrap; arrival-order merging failed the
same harness.

## Sample (`--sample`)

Contract: [README → Sample](README.md#sample---sample). `$R` and `$A`/`$API_PORT`
as above. Covered by `test/integration/retrieve-sample.test.ts`; cadence, the
in-flight read at a stop, and the flag rules are pinned in
`test/unit/retrieve-sample.test.ts`.

### SA1. Three samples, one interval apart, on either transport

```bash
centrs retrieve $R /ip/address --sample 1s --count 3 --username $U --password $P --json
centrs retrieve $A /ip/address --via native-api --sample 1s --count 3 --port $API_PORT --username $U --password $P --json
```

Each run prints three `sample` lines (`index` 1–3, `data` a row array) and a
summary with `stopReason: "count-reached"`, `samples: 3`. Consecutive `at`
values are at least one second apart. `meta.via` is the transport used.

### SA2. Counters `listen` never reports

```bash
centrs retrieve $A /interface --via native-api --attributes name,rx-byte --sample 1s --count 3 --port $API_PORT --username $U --password $P --json
```

Every row has only `name` and `rx-byte`. `ether1`'s `rx-byte` in the third
sample is higher than in the first, since the test's own API traffic arrives
on `ether1`.

### SA3. A singleton with one `--attribute`

```bash
centrs retrieve $R /system/resource --attribute uptime --sample 1s --count 2 --username $U --password $P --json
```

Each sample's `data` is the bare `uptime` string, and the two differ.

### SA4. A removal is absence in the next sample

```bash
centrs retrieve $A /ip/firewall/address-list --via native-api --sample 500ms --count 2 --port $API_PORT --username $U --password $P --json
```

Add an address-list row before the run and remove it after the first sample.
The first sample's rows include its `.id`; the second sample's do not.

### SA5. `--follow` and `--sample` are exclusive

```bash
centrs retrieve $R /ip/address --sample 1s --follow --username $U --password $P --json
```

One envelope: `ok: false`, `usage/conflicting-flags`, exit 1. No summary.

### SA6. NDJSON is readable before the process exits; Ctrl-C ends it cleanly

```bash
centrs retrieve $A /system/resource --via native-api --sample 1s --format ndjson --port $API_PORT --username $U --password $P
```

Run as a subprocess. The first `sample` line parses while the process is still
running; after `SIGINT` the last line is a successful summary with
`stopReason: "interrupted"`, and the exit code is 0.

## Query (`--query`, #397)

Contract: [README → Query](README.md#query---query). `$R` and `$A`/`$API_PORT`
as above. Covered by `test/integration/retrieve-query.test.ts`, which seeds
address-list, VLAN and firewall-filter rows; the grammar and compiled words are
pinned in `test/unit/query.test.ts`.

### QY1. The same rows as RouterOS's `find where`

```bash
centrs retrieve $R /ip/firewall/address-list --query 'comment and !disabled' --username $U --password $P --json
centrs retrieve $A /interface/vlan --via native-api --query 'vlan-id>10 and vlan-id<100 or disabled' --port $API_PORT --username $U --password $P --json
```

For each of 58 expressions across three menus (equality, `!=`, numeric
ordering, ordering on a property some rows lack, quoted values and their escapes, bare booleans, bare "is set" names, `and`/`or`
precedence, parentheses, `!(…)`), the `.id`s returned over both transports
equal the ids `:put [<menu> find where <expression>]` prints on the same
router.

### QY2. Where the query and the CLI differ, as documented

```bash
centrs retrieve $R /ip/firewall/filter --query 'dst-port=80' --username $U --password $P --json
centrs retrieve $R /ip/firewall/address-list --query 'list=qa-397 and address>192.0.2.9' --username $U --password $P --json
```

The first returns the rule whose `dst-port` is `"80"`, although
`find where dst-port=80` selects nothing (the CLI reads `80` as a number). The
second compares `address` as text, so `192.0.2.10` is not above `192.0.2.9`.

### QY3. `--filter` and repeated `--query` are AND-ed

```bash
centrs retrieve $R /ip/firewall/address-list --filter list=qa-397 --query comment --query '!disabled' --attributes address --username $U --password $P --json
```

`data` is exactly `[{ "address": "192.0.2.9" }]`.

### QY4. A regex fails before anything is sent

```bash
centrs retrieve $R /interface --query 'name~"^ether"' --username $U --password $P --json
```

`ok: false`, `input/unsupported-query`, exit 1.

### QY5. A misspelled property fails validation

```bash
centrs retrieve $A /ip/firewall/address-list --via native-api --query 'lists=qa-397' --port $API_PORT --username $U --password $P --json
```

`validation/unknown-attribute`. Without the check RouterOS would answer with
no rows and no error.

### QY6. A singleton has no rows to filter

```bash
centrs retrieve $R /system/identity --query 'name=MikroTik' --username $U --password $P --json
```

`usage/conflicting-flags`.

### QY7. `--sample` reads the filtered rows each time

```bash
centrs retrieve $R /ip/firewall/address-list --query 'list=qa-397 and disabled' --sample 500ms --count 2 --username $U --password $P --json
```

Both samples hold only the disabled `qa-397` row.

## Filtered follow

Covered by `test/integration/retrieve-filtered-follow.test.ts` (FQ1–FQ5).
The harness seeds address-list rows and changes them while following, with
validation enabled. `$A`/`$API_PORT` are the native-API target as above.

### FQ1. Projection and both membership directions

```bash
centrs retrieve $A /ip/firewall/address-list --via native-api --port $API_PORT --username $U --password $P --follow --query 'list=fq1' --query 'comment=a and !disabled' --attributes address --count 2 --duration 10s --json
```

Initially only the matching row appears. Changing its comment out of the
predicate emits a `removed` frame with `source: "membership"`; changing an
excluded row into it emits an `upsert` with the same source. `data` contains
only `address`, while identity remains in meta.

### FQ2. Minimal deletion frames

```bash
centrs retrieve $A /ip/firewall/address-list --via native-api --port $API_PORT --username $U --password $P --follow --query 'list=fq1 and comment=a' --sweep 0 --count 1 --duration 10s --json
```

Deleting an excluded row emits nothing; deleting the held row emits one
`removed` with `source: "listen"`. Predicate fields are absent from `.dead`.

### FQ3. Silent predicate exit

```bash
centrs retrieve $A /ip/firewall/address-list --via native-api --port $API_PORT --username $U --password $P --follow --query 'list=fq3 and timeout>8s' --sweep 200ms --count 1 --duration 6s --json
```

The harness adds a row with a 10-second timeout. A sweep removes it from the
selected set as its remaining timeout crosses 8 seconds, with
`source: "membership"`; the row still exists in an unfiltered read.

### FQ4. CLI alias and predicate validation

```bash
centrs retrieve $A /ip/firewall/address-list --port $API_PORT --username $U --password $P --follow --filter list=fq3 --attributes address --duration 500ms --json
centrs retrieve $A /ip/firewall/address-list --port $API_PORT --username $U --password $P --follow --query lits=fq3 --json
```

The first emits projected snapshot rows and `synced`. The typo in the second
fails `validation/unknown-attribute` before listen starts.

### FQ5. Filtered bootstrap and live churn

```bash
centrs retrieve $A /ip/firewall/address-list --port $API_PORT --username $U --password $P --follow --query 'list=fq5 and comment=in' --attributes address --sweep 200ms --duration 6s --json
```

The harness changes membership during bootstrap and live operation, then
deletes rows. Applying all frames yields exactly the ids and projected rows
of a fresh filtered print after churn settles. Deterministic delayed-reply,
delete and cancellation orderings are anchored in `retrieve-follow.test.ts`.
