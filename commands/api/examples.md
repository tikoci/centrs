# api — examples

Each numbered example is an executable spec asserted by CHR integration tests
(booted by `@tikoci/quickchr`), example N ↔ assertion N:
`test/integration/api.test.ts` (rest-api examples),
`test/integration/api-native.test.ts` (native-api examples, N…),
`test/integration/api-listen.test.ts` (streaming examples, L…), and
`test/integration/api-fanout.test.ts` (fan-out examples, F…), and
`test/integration/retrieve-query.test.ts` (query grammar examples, QA…). If a line here is not
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
`meta.validation.semantic=not-applicable` (script, not a path) and
`meta.validation.stages` is `offline: passed` then live `device: passed` from
`:put [:parse ...]`.

### 16b. The `/execute` script is gated offline (GH#354)

Until GH#354 the script-mode carve-out meant this surface ran **no** preflight at
all. The offline analyzer is the whole stage-1 gate here, and it opens no
connection — the unreachable port proves it.

```bash
centrs api 127.0.0.1:1 execute -X POST -f script=':put [' --username $U --password $P --yes
```

Envelope: `ok: false`, `error.code=validation/syntax`,
`error.context.validationStage="offline"`, `error.context.surface="api /execute"`,
`error.context.span={"start":5,"end":6}`, and **not** a `transport/*` code.
`meta.validation.stages` is `offline: failed` then `device: skipped`.

### 16c. Offline pass continues to live `:parse`

```bash
centrs api $R execute -X POST -f script='/ip/address/add no-such-arg=x' --username $U --password $P --yes
```

Envelope: `ok: false` with a device validation code
(`validation/unknown-attribute`, or `validation/syntax` on older RouterOS), and
`meta.validation.stages` is `offline: passed` then `device: failed`. Offline
acceptance remains `runtimeAcceptance: not-proven`; it never suppresses the live
stage.

### 16d. A runtime rejection in `/execute` output is not `ok: true`

```bash
centrs api $R execute -X POST -f script='/ip/service/set www-ssl certificate=nope' --username $U --password $P --yes
```

Envelope: `ok: false`, `error.code=routeros/invalid-value`. `as-string` makes
the console's own text the reply body, so RouterOS carries this rejection in an
HTTP-200 `ret`; the validation gate stays `passed` because it did pass — the
command was rejected at run, not at validation. Ordinary output that merely
mentions a fault string (`:put "status: no such item appears in help"`) stays
`ok: true`.

### 17. `--via rest-api --stream` is rejected

```bash
centrs api $R ip/address --stream --via rest-api --username $U --password $P
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
~second), `meta.via=rest-api`. This is an ordinary bounded call — no `--stream`,
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

### 22. `--raw --validate=true` still runs the gate (#154)

```bash
centrs api $R ip/no-such-menu --raw --validate=true --username $U --password $P
```

`--raw` only **defaults** `--validate` to false, so an explicit `--validate=true`
wins and the `/console/inspect` preflight runs. The rejection comes back in the
`--raw` error shape, not the envelope: stdout empty, stderr a compact
`{"code":"validation/unknown-path","message":…}`, nonzero exit, and no `data`
key. Contrast example 13, where bare `--raw` skips the preflight entirely. This
pair is how you tell a RouterOS rejection from a centrs bug while staying on the
bare-passthrough surface.

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

Envelope: `ok: true`, `data` contains the CHR identity and validation reports
offline plus live `:parse` stages passed.

### N8b. Native `/execute` also rejects at live `:parse`

```bash
centrs api $A execute -X POST -f script='/ip/address/add no-such-arg=x' --via native-api --port $API_PORT --username $U --password $P --yes
```

Envelope: `ok: false`; the accepted version-specific validation code is
`validation/unknown-attribute` or `validation/syntax`, with stages
`offline: passed`, `device: failed`.

### N8c. Native `/execute` runtime rejection fails the envelope

```bash
centrs api $A execute -X POST -f script='/ip/service/set www-ssl certificate=nope' --via native-api --port $API_PORT --username $U --password $P --yes
```

Envelope: `ok: false`, `error.code=routeros/invalid-value`, with the validation
stages still `passed` — the same normalization as REST, since both adapters
surface the `as-string` console text as `data`.

## listen / `--stream` (native-api only)

`api` sends the command as typed (#402). Following changes is the menu's
`listen`, requested as a `<menu>/listen` endpoint, which implies `--stream` and
native-api. `--stream` delivers any command's replies incrementally: one NDJSON
envelope per wire reply (`!re` row or `!empty`), then a terminating summary.
`--listen` is removed (`usage/removed-flag`, unit- and smoke-tested with its
exact replacement).

### L1. A `/listen` stream emits a change as an NDJSON frame, then a summary

```bash
centrs api $A ip/address/listen --count 1 --via native-api --port $API_PORT --username $U --password $P
```

While listening, the harness adds an address over REST. stdout is NDJSON: at least
one envelope frame for the new row (`meta.operation.stream.kind=frame`,
`reply=re`), then a final summary envelope (`meta.operation.stream.kind=summary`,
`meta.operation.stream.stopReason=count-reached`,
`meta.operation.stream.rows>=1`). Exit code 0 (successful local count stop).

### L2. A deletion frame carries `.dead`

```bash
centrs api $A ip/address/listen --duration 3s --via native-api --port $API_PORT --username $U --password $P
```

The harness removes a pre-seeded address; an emitted frame's record carries
`.dead=true` (a minimal `{ ".id", ".dead" }` record, per the CHR-grounded
`commands/api/AGENTS.md`).

### L3. `/listen` endpoint infers native + streaming

```bash
centrs api $A "ip/address/listen" --count 1 --port $API_PORT --username $U --password $P
```

No `--stream` / `--via` given; the `/listen` endpoint infers `--stream` and
`--via native-api` (`meta.via=native-api`). Same NDJSON shape as L1.

### L4. Bounded `--duration` reports its stop reason

```bash
centrs api $A ip/address/listen --duration 2s --via native-api --port $API_PORT --username $U --password $P
```

With no change during the window, the stream ends after ~2 s with a summary
envelope whose `meta.operation.stream.stopReason=duration-elapsed`, `rows=0`,
`empty=1`. Exit code 0. RouterOS answers the cancel of a listen that sent
nothing with interrupted, `!empty`, `!done`: that `!empty` is the one frame,
with `reply=empty`, `data=null` and `afterStop: true`.

### L5. A router that ignores `/cancel` cannot hold the process open

```bash
centrs api $A ip/address --stream --duration 200ms --timeout 1s --via native-api --port $API_PORT --username $U --password $P
```

A stream stopped by `--duration` or Ctrl-C sends `/cancel` and waits up to
`--timeout` for the router's acknowledgement (the interrupted `!trap` and
`!done`). If none arrives, centrs closes the session itself. The summary still
reports its stop reason (`duration-elapsed` or `interrupted`), exit code is 0,
and `warnings` carries `transport/cancel-unacknowledged`. A router that answers
inside the window gets no warning. `--count` sends `/cancel` without waiting,
so it exits at once and never warns (#385).

RouterOS on CHR always acknowledges `/cancel`, so this example runs against a
loopback native-API peer that ignores it, as a real CLI process:
`test/integration/api-stream-cancel.test.ts` covers `--duration`, SIGINT,
`--count` and the cooperative control. The session-level cases (silent peer,
chatty peer, trap without `!done`, close after cancel) are in
`test/unit/native-api.test.ts`.

### L6. Finite ping completes naturally

```bash
centrs api $A tool/ping -X POST -f address=10.0.2.2 -f count=3 --stream --yes --via native-api --port $API_PORT --username $U --password $P
```

Three reply frames, then a successful summary with `meta.operation.stream.stopReason=completed`.
The device's `count=3` completes the command; no centrs `--count` is needed.

### L7. Monitor replies preserve `.section`

```bash
centrs api $A interface/monitor-traffic -X POST -f interface=ether1 -f duration=2s --stream --yes --via native-api --port $API_PORT --username $U --password $P
```

One or more rows carrying device `.section` values, then `completed`.

### L8. Explicit print interval streams instead of listening

```bash
centrs api $A system/resource/print -X POST -f interval=1 --stream --count 2 --via native-api --port $API_PORT --username $U --password $P
```

Two reply frames and a `count-reached` summary. POST print stays read-only.

### L9. Projection is sent as typed; the tip says what it hides

```bash
centrs api $A ip/address/listen --proplist address --duration 3s --via native-api --port $API_PORT --username $U --password $P
centrs api $A ip/address/listen --proplist address,.id,.dead --duration 3s --via native-api --port $API_PORT --username $U --password $P
```

The harness deletes a seeded address during each. With `address` alone no
frame carries `.dead` for it, and the leading notice and the summary carry
`tip/follow-proplist`.
With `address,.id,.dead` the delete frame is `{ ".id", ".dead": "true" }` and
there is no tip.

### L10. A filtered listen is sent as typed, with a tip

```bash
centrs api $A ip/address/listen --query interface=ether1 --duration 3s --via native-api --port $API_PORT --username $U --password $P
```

The harness deletes a seeded `ether1` address while listening. RouterOS sends
nothing for it: the only frame is the cancellation `!empty` (`afterStop`).
The first line is a `notice` with `tip/filtered-follow`; the summary is `ok`
and repeats it. `--raw-query` is sent
the same way.

### L11. Command attributes are validated

```bash
centrs api $A tool/ping -X POST -f no-such-arg=x --stream --yes --via native-api --port $API_PORT --username $U --password $P
```

`validation/unknown-attribute`; no ping stream starts.

### L12. Streaming keeps the mutator confirmation gate

```bash
centrs api $A system/license/renew -X POST --stream --via native-api --port $API_PORT --username $U --password $P
```

Non-interactively, `usage/confirmation-required`; no renew operation is sent.

### L13. Mutation streams retain method mapping and terminal `ret`

```bash
centrs api $A ip/address -X PUT -f address=198.51.100.34/32 -f interface=ether1 --stream --yes --via native-api --port $API_PORT --username $U --password $P
```

A successful zero-row summary with `data.done.ret` naming the created address.
The harness retrieves that ID to check its address, then streams DELETE on that
ID and requires natural completion. Neither mutation becomes a listen.

### L14. Streamed `/execute` runtime errors fail the terminal summary

```bash
centrs api $A execute -X POST --stream --via native-api --yes --json -f 'script=/ip/service/set www-ssl certificate=nope' --port $API_PORT --username $U --password $P
```

With validation enabled and no `nope` certificate, syntax validation passes but
RouterOS rejects the value at runtime. The sole terminal envelope is `ok: false`,
`routeros/invalid-value`, and `meta.operation.stream.stopReason=routeros-error`; the CLI exits nonzero.
Ordinary stdout such as `:put "status: no such item appears in ordinary output"`
still completes successfully with its text in `data.done.ret`.

### L15. An addressed listen reports its deletion; a projection hides it

```bash
centrs api $A "ip/address/$ID/listen" --duration 3s --via native-api --port $API_PORT --username $U --password $P
centrs api $A "ip/address/$ID/listen" --duration 3s --proplist address --via native-api --port $API_PORT --username $U --password $P
```

For each variant the harness seeds an address, starts the addressed listen
(`?.id=$ID`), and deletes it after the listening barrier. Without projection
the stream emits `.id=$ID` with `.dead=true` and no tip. With `--proplist
address` RouterOS strips both, so the delete is one `!re` with no attributes
(`data={}`) and the summary carries `tip/follow-proplist`.

### L16. POST print preserves query/projection in either delivery mode

```bash
centrs api $A ip/address/print -X POST --query address=198.51.100.34/32 --proplist address --via native-api --port $API_PORT --username $U --password $P
centrs api $A ip/address/print -X POST --query address=198.51.100.34/32 --proplist address --stream --via native-api --port $API_PORT --username $U --password $P
```

The harness seeds the L13 address. Both modes return only that address and only
the requested `address` field; the streamed form then completes naturally. The
one-shot REST equivalent is also checked, using the same query/projection.

### L17. A GET stream is one literal print

```bash
centrs api $A ip/address --stream --via native-api --port $API_PORT --username $U --password $P
```

The print completes on its own (`stopReason=completed`) with one `re` frame
per row (`rows` equals a one-shot GET's row count); a leading notice and the
summary carry `tip/stream-print` naming `ip/address/listen`. It never becomes a listen.

### L18. Zero-row ticks are `!empty` frames and do not use up `--count`

```bash
centrs api $A ip/firewall/raw/print -X POST -f interval=1 --stream --count 1 --duration 2500ms --via native-api --port $API_PORT --username $U --password $P
```

On the CHR's empty raw table, each tick is a frame with `reply=empty` and
`data=null`; at least two arrive. They do not count toward `--count 1`, so the
stream ends on `duration-elapsed` with `rows=0`.

Loopback regressions in `test/integration/api-stream-command.test.ts` also
exercise natural/empty completion, `!empty` frames, row-only `--count`,
`afterStop`, the stream tips, `--format ndjson`, terminal `ret`,
first/midstream trap, unsolicited interruption, fatal/close, and nonzero
process exit with the failure summary on stdout. Device-dependent examples
L6–L18 run in `test/integration/api-listen.test.ts` with validation enabled.

## fanout (multi-target, F…)

These run against a CDB fixture with two records sharing group `$G`: record 0 is
the live CHR (comment `board=chr`), record 1 is an unreachable host (comment
`board=dead`). Fan-out output is the locked `FanoutData` envelope
(`data = { summary, targets[] }`; outer `ok` = orchestration success; per-target
failures are inner `ok:false`), with the granular exit code (0 all-ok / 2 partial /
1 all-failed or orchestration error). See `test/integration/api-fanout.test.ts`.
The `--raw`/`--stream` + fan-out guards are network-free and validated in
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

## `--query` grammar (#397)

`--query` takes the `print where` grammar shared with `retrieve --query`. The
test seeds `qa-397` address-list rows, one of them disabled with comment `x>y`.

### QA1. A bare boolean is `=yes`, on either transport

```bash
centrs api $R ip/firewall/address-list --query 'list=qa-397 and disabled' --proplist address --username $U --password $P
centrs api $A ip/firewall/address-list --via native-api --query 'list=qa-397 and disabled' --proplist address --port $API_PORT --username $U --password $P
```

Both return only the disabled row's address.

### QA2. A value containing an operator stays one value

```bash
centrs api $R ip/firewall/address-list --query 'comment=x>y' --proplist address --username $U --password $P
```

Returns the row whose comment is `x>y`; the query word sent is `comment=x>y`.

## quickchr targets (#134)

`$NAME` is the machine name of a running quickchr-managed CHR. Host/port/auth
come from the live descriptor (see `commands/retrieve/examples.md` Q-series).
Covered by `test/integration/quickchr-target.test.ts`.

### Q1. GET against a quickchr target

```bash
centrs api --quickchr $NAME system/resource --json
```

Envelope: `ok: true`, `data` is the resource object,
`meta.target.source.kind=provider`.
