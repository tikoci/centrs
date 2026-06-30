# api — examples

Each numbered example is an executable spec asserted by CHR integration tests
(booted by `@tikoci/quickchr`), example N ↔ assertion N:
`test/integration/api.test.ts` (rest-api examples),
`test/integration/api-native.test.ts` (native-api examples, N…),
`test/integration/api-listen.test.ts` (streaming examples, L…), and
`test/integration/api-fanout.test.ts` (fan-out examples, F…). If a line here is not
exercised by a test, the test file is wrong; if a line passes only with
`--validate=false`, the implementation is wrong (see
[`docs/CONSTITUTION.md`](../../docs/CONSTITUTION.md)).

`$R` is `<host>:<rest-port>` resolved by quickchr. `$A` is `<host>` and
`$API_PORT` is the native API port (`chr.ports.api`). `$U` / `$P` are CHR
credentials provided by the harness. `$ID` is the `.id` returned by the preceding
add in the same transport section. All write-shaped examples pass `--yes`.

## rest-api (`--via rest-api`, the default)

### 1. GET a list

```bash
centrs api $R ip/address --username $U --password $P
```

Envelope: `ok: true`, `data` is an array of rest-style records,
`meta.via=rest-api`, `meta.validation.source` includes `/console/inspect request=child`.

### 2. Endpoint normalization variants resolve to one path

```bash
centrs api $R "/rest/ip/address" --username $U --password $P
centrs api $R "rest/ip/address" --username $U --password $P
centrs api $R "ip address" --username $U --password $P
```

Each resolves to the same canonical path; `meta.request.path == "/ip/address"`
and the `data` array matches example 1.

### 3. GET a singleton

```bash
centrs api $R system/resource --username $U --password $P
```

Envelope: `ok: true`, `data` is a single object (not an array) with `uptime`,
`version`, etc.

### 4. PUT add (RouterOS create; documents the PUT≠POST trap)

```bash
centrs api $R ip/address -X PUT -f address=198.51.100.10/32 -f interface=ether1 -f comment=centrs-api-rest --username $U --password $P --yes
```

Envelope: `ok: true`, `data[".id"]` matches `/^\*[0-9A-F]+$/`, `meta.via=rest-api`.
A subsequent GET of `/ip/address` contains the new row.

### 5. PATCH set by id-in-path

```bash
centrs api $R ip/address/$ID -X PATCH -f comment=centrs-api-rest-set --username $U --password $P --yes
```

Envelope: `ok: true`; re-reading `ip/address/$ID` shows the new comment.

### 6. DELETE remove by id-in-path

```bash
centrs api $R ip/address/$ID -X DELETE --username $U --password $P --yes
```

Envelope: `ok: true`; a subsequent GET of `/ip/address` does not contain `$ID`.

### 7. Raw JSON body with `-d`

```bash
centrs api $R ip/address -X PUT -d '{"address":"198.51.100.11/32","interface":"ether1"}' --username $U --password $P --yes
```

Envelope: `ok: true`, `data[".id"]` present.

### 8. Body from stdin with `--input -`

```bash
echo '{"address":"198.51.100.12/32","interface":"ether1"}' | centrs api $R ip/address -X PUT --input - --username $U --password $P --yes
```

Envelope: `ok: true`, `data[".id"]` present.

### 9. Server-side filter with `--query`

```bash
centrs api $R interface --query type=ether --username $U --password $P
```

Envelope: `ok: true`, every returned record has `type=ether`; the request carried
a REST `.query` (not client-side filtering).

### 10. Projection with `--proplist`

```bash
centrs api $R ip/address --proplist address,interface --username $U --password $P
```

Envelope: `ok: true`, each record has only the requested properties (plus `.id`).

### 11. Validation rejects an unknown attribute before the write

```bash
centrs api $R ip/address -X PUT -f address=198.51.100.13/32 -f interface=ether1 -f no-such-arg=x --username $U --password $P --yes
```

Envelope: `ok: false`, `error.code=validation/unknown-attribute`,
`meta.validation.source=/console/inspect`, and no address is added.

### 12. Validation rejects an unknown path

```bash
centrs api $R ip/no-such-menu --username $U --password $P
```

Envelope: `ok: false`, `error.code=validation/unknown-path`, no request issued.

### 13. `--raw` success prints the bare RouterOS body

```bash
centrs api $R ip/address --raw --username $U --password $P
```

stdout is the bare RouterOS JSON array (no `meta`/`warnings`); validation is
skipped; exit code 0.

### 14. `--raw` RouterOS error → stderr + nonzero exit

```bash
centrs api $R ip/address -X PUT -f address=not-an-ip -f interface=ether1 --raw --username $U --password $P --yes
```

stdout is empty; stderr carries the RouterOS error payload as JSON; exit code is
nonzero.

### 15. Mutating + non-TTY + no `--yes` is refused

```bash
centrs api $R ip/address -X PUT -f address=198.51.100.14/32 -f interface=ether1 --username $U --password $P </dev/null
```

Envelope: `ok: false`, `error.code=usage/confirmation-required`, no request
issued, no address added. (Holds under `--raw` too.)

### 16. POST run a console command via `/rest/execute`

```bash
centrs api $R execute -X POST -f script=':put [/system/identity/get name]' --username $U --password $P --yes
```

Envelope: `ok: true`, `data` is string-shaped and contains the CHR identity;
`meta.validation.semantic=not-applicable` (script, not a path).

### 17. `--via rest-api --listen` is rejected

```bash
centrs api $R ip/address --listen --via rest-api --username $U --password $P
```

Envelope: `ok: false`, `error.code=transport/capability-unsupported` (REST cannot
follow); no silent open-ended poll.

### 18. `--query` not-equal maps to a negated stack word

```bash
centrs api $R interface --query type!=ether --username $U --password $P
```

Envelope: `ok: true`, no returned record has `type=ether`; the request carried
REST `.query` words `["type=ether","#!"]` (eq then NOT-top).

### 19. `--raw-query` expresses OR

```bash
centrs api $R interface --raw-query type=ether --raw-query type=loopback --raw-query '#|' --username $U --password $P
```

Envelope: `ok: true`, returns the union of `ether` and `loopback` interfaces; the
raw words are passed through verbatim as `.query` (REST) / `?` words (native).

### 20. Bounded `duration=` command returns a `.section` array (not a stream)

```bash
centrs api $R interface/monitor-traffic -X POST -f interface=ether1 -f duration=5s --username $U --password $P --yes
```

Envelope: `ok: true`, `data` is an **array** of `.section`-keyed records (one per
~second), `meta.via=rest-api`. This is an ordinary bounded call — no `--listen`,
no NDJSON. `monitor-traffic` is a command (not `print`/`get`), so it is a
`POST` and write-classed (needs `--yes`); centrs never relaxes that to read-only.
(REST bounds it at the 60 s cap; native has no cap.)

### 21. GET one row by id together with `--proplist`

```bash
centrs api $R ip/address/$ID --proplist address --username $U --password $P
```

Envelope: `ok: true`, `data` is a **single object** (not an array) carrying only
the projected property `address` (RouterOS omits `.id` unless it is in the
proplist). Combining an id with `--query`/`--proplist` folds the id into the REST
`.query` (`.id=$ID`) and rides a `POST …/print`, then unwraps the one row —
matching the native `?.id=` read. (Plain id-only reads still use the `GET …/$ID`
URL form; see example 5's re-read.)

## native-api (`--via native-api`)

The same contract over the binary API. Validation still runs through
`/console/inspect`, issued as native commands. Values are strings.

### N1. GET a list

```bash
centrs api $A interface -X GET --via native-api --port $API_PORT --username $U --password $P
```

Envelope: `ok: true`, `data` is an array of rest-style records (string values),
`meta.via=native-api`.

### N2. PUT add (returns `.id`)

```bash
centrs api $A ip/address -X PUT -f address=198.51.100.20/32 -f interface=ether1 --via native-api --port $API_PORT --username $U --password $P --yes
```

Envelope: `ok: true`, `data[".id"]` present.

### N3. PATCH set by id (id → `=.id=` word)

```bash
centrs api $A ip/address/$ID -X PATCH -f comment=centrs-api-native-set --via native-api --port $API_PORT --username $U --password $P --yes
```

Envelope: `ok: true`; re-reading shows the new comment.

### N4. DELETE remove by id (id → `=.id=` word)

```bash
centrs api $A ip/address/$ID -X DELETE --via native-api --port $API_PORT --username $U --password $P --yes
```

Envelope: `ok: true`; the row is gone.

### N5. GET one by id (→ `print ?.id=`)

```bash
centrs api $A ip/address/$ID2 -X GET --via native-api --port $API_PORT --username $U --password $P
```

Envelope: `ok: true`, `data` is a single object whose `.id` is `$ID2`.

### N6. Validation rejects an unknown attribute over native

```bash
centrs api $A ip/address -X PUT -f address=198.51.100.21/32 -f interface=ether1 -f no-such-arg=x --via native-api --port $API_PORT --username $U --password $P --yes
```

Envelope: `ok: false`, `error.code=validation/unknown-attribute`, no row added —
caught by the inspect gate, not a native `!trap`.

### N7. `--raw` over native

```bash
centrs api $A interface --raw --via native-api --port $API_PORT --username $U --password $P
```

stdout is the bare rest-style array (string values); exit code 0.

### N8. POST run a console command via native `/execute`

```bash
centrs api $A execute -X POST -f script=':put [/system/identity/get name]' --via native-api --port $API_PORT --username $U --password $P --yes
```

Envelope: `ok: true`, `data` contains the CHR identity.

## listen (native-api only)

### L1. `--listen` streams a change as an NDJSON frame, then a summary

```bash
centrs api $A ip/address --listen --count 1 --via native-api --port $API_PORT --username $U --password $P
```

While listening, the harness adds an address over REST. stdout is NDJSON: at least
one envelope frame for the new row, then a final summary envelope
(`data.stopReason=count-reached`, `data.frames>=1`). Exit code 0 (stream started
cleanly).

### L2. A deletion frame carries `.dead`

```bash
centrs api $A ip/address --listen --count 1 --via native-api --port $API_PORT --username $U --password $P
```

The harness removes a pre-seeded address; the emitted frame's record carries
`.dead=true` (a minimal `{ ".id", ".dead" }` record, per the CHR-grounded
`commands/api/AGENTS.md`).

### L3. `/listen` endpoint infers native + streaming

```bash
centrs api $A "ip/address/listen" --count 1 --username $U --password $P
```

No `--listen` / `--via` given; the `/listen` endpoint infers `--listen` and
`--via native-api`. Same NDJSON shape as L1.

### L4. Bounded `--duration` reports its stop reason

```bash
centrs api $A ip/address --listen --duration 2s --via native-api --port $API_PORT --username $U --password $P
```

After ~2s the stream ends with a summary envelope whose
`data.stopReason=duration-elapsed`. Exit code 0.

## fanout (multi-target, F…)

These run against a CDB fixture with two records sharing group `$G`: record 0 is
the live CHR (comment `board=chr`), record 1 is an unreachable host (comment
`board=dead`). Fan-out output is the locked `FanoutData` envelope
(`data = { summary, targets[] }`; outer `ok` = orchestration success; per-target
failures are inner `ok:false`), with the granular exit code (0 all-ok / 2 partial /
1 all-failed or orchestration error). See `test/integration/api-fanout.test.ts`.
The `--raw`/`--listen` + fan-out guards are network-free and validated in
`test/integration/cli-smoke.test.ts`.

### F1. `--group` fans a GET out; a dead target is an inner failure

```bash
centrs api --group $G ip/address --cdb-file $CDB --json
```

`ok: true`, `data.summary = { total: 2, ok: 1, failed: 1 }`, `data.targets[]` in
record-index order (`[0, 1]`): target 0 is an inner success (`meta.via=rest-api`),
target 1 is inner `ok:false` with `error.code=transport/connection-refused`.
`meta.operation.kind=fanout`. Exit code 2.

### F2. `--where` selects only the matching device

```bash
centrs api --where board=chr ip/address --cdb-file $CDB --json
```

The device-class selector matches only record 0, so `data.summary = { total: 1,
ok: 1, failed: 0 }`, one inner success. Exit code 0.

### F3. An empty selection is `ok:true` with summary 0/0/0

```bash
centrs api --group no-such-group ip/address --cdb-file $CDB --json
```

`ok: true`, `data.summary = { total: 0, ok: 0, failed: 0 }`, `data.targets = []`,
and a `cdb/empty-group` warning. Exit code 0.

### F4. A mutating fan-out without `--yes` is rejected, naming the blast radius

```bash
centrs api -X PUT ip/address -f address=10.99.0.1/32 -f interface=ether1 --group $G --cdb-file $CDB --json
```

Non-interactive and unconfirmed: outer `ok:false`,
`error.code=usage/confirmation-required`, and the message names the router count
(`2 router(s)`) and that `--yes` is required. No write is attempted. Exit code 1.

### F5. A mutating fan-out with `--yes` writes across the selected devices

```bash
centrs api -X PUT ip/address -f address=10.99.0.7/32 -f interface=ether1 --where board=chr --yes --cdb-file $CDB --json
```

Confirmed once up front; the add runs on record 0 only (selected by `--where`).
`data.summary = { total: 1, ok: 1, failed: 0 }`, the inner success carries the
created `.id`. Exit code 0.

The fixture for F6–F9 adds record 2 — the reserved `__default__` credential record.

### F6. `--all` fans across every record except `__default__`

```bash
centrs api --all ip/address --cdb-file $CDB --json
```

`data.summary = { total: 2, ok: 1, failed: 1 }`, `data.targets[]` record indices
`[0, 1]` (record 2 `__default__` is excluded). Exit code 2.

### F7. A positional + `--group` union de-dupes by record index

```bash
centrs api $R0 --group $G ip/address --cdb-file $CDB --json
```

`$R0` is record 0's target, also a member of `$G`; the union is `{0, 1}` — record
indices `[0, 1]`, `total = 2` (not 3). Exit code 2.

### F8. `--concurrency` bounds the worker pool

```bash
centrs api --group $G --concurrency 1 ip/address --cdb-file $CDB --json
```

Runs one target at a time; `meta.operation.concurrency = 1`, still
`data.summary = { total: 2, ok: 1, failed: 1 }`. (`--concurrency 2abc` / `1.5` are
rejected at parse time with `usage/invalid-concurrency`.) Exit code 2.

### F9. `--default` selects `__default__`, which fails the connectable guard

```bash
centrs api --default ip/address --cdb-file $CDB --json
```

The reserved record is a credential fallback, not a connectable router, so its one
target fails deterministically: inner `ok:false` with
`error.code=target/unresolved` (never a `transport/dns` attempt on `"__default__"`).
`data.summary = { total: 1, ok: 0, failed: 1 }`. Exit code 1 (every target failed).
