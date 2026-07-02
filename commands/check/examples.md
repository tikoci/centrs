# check — examples

Each numbered example is an executable spec. The integration test under
`test/integration/check.test.ts` runs the CHR-backed examples against a CHR
booted by `@tikoci/quickchr`; offline examples (flag parsing, `--list-checks`,
fixture-backed `--save`) run under `test/unit/check.test.ts`. Example N ↔
assertion N. If a line here is not exercised by a test, the test file is wrong;
if a line passes only with `--validate=false`, the **implementation** is wrong
(see `docs/CONSTITUTION.md`).

These examples are the **target** for `CHR-passed`; the cells are `designed`
today, so nothing here is green yet.

`$R` is `<host>:<rest-port>` resolved by quickchr. `$U` / `$P` are CHR
credentials from the harness. Envelope-asserting examples pass `--json`.

## Smart battery (default)

### 1. Bare check runs the smart battery

```bash
centrs check $R --username $U --password $P --json
```

Envelope: `ok: true` (a healthy CHR raises warnings/tips at most, not errors),
`data.checks[]` includes at least `reach`, `services`, `resource`, `cloud`,
`dns`; each entry has `ran: true` and a `metadata` object. `data.profile`
carries `board`, `arch`, `version`, `channel`. `meta.via` is the transport the
battery rode.

### 2. Profile block is populated

```bash
centrs check $R --username $U --password $P --json
```

Assert `data.profile.ports` maps `rest-api`/`native-api` to the live
`/ip/service` ports, and `data.profile.reachable` lists the transports that
answered. (Shape is additive/non-normative — assert presence, not an exact key
set.)

### 3. No credentials → reach only, tip for the rest

```bash
centrs check $R --json
```

Envelope: `ok: true`; `data.checks[]` has `reach` (`ran: true`) while the health
checks report `ran: false` with `skipReason` naming missing credentials, and a
`tip/check/credentials-needed` is present.

## Selection and presets

### 4. `--preset reach` is the fast slice

```bash
centrs check $R --username $U --password $P --preset reach --json
```

Only the `reach` check ran; no health-phase reads were issued. (This is the slice
`discover`'s IP-scan iterates.)

### 5. `--checks` runs an explicit subset (+ dependencies)

```bash
centrs check $R --username $U --password $P --checks services,resource --json
```

`data.checks[]` contains exactly `services` and `resource` (and any `dependsOn`),
nothing else.

### 6. `--skip` subtracts from the default

```bash
centrs check $R --username $U --password $P --skip dns --json
```

The default battery ran except `dns` (absent from `data.checks[]`).

### 7. `--list-checks` explains the catalog (offline)

```bash
centrs check --list-checks --json
```

No network IO. `data` lists every registered check with `id`, `title`,
`description`, `tags`, `phase`, `default`. Exit `0`.

## Findings and reaching green

### 8. A risky service raises a warning

Precondition: telnet is enabled on the CHR (stock CHR 7.23.1 has it enabled;
if the fixture hardened services first, run `/ip/service enable telnet`).

```bash
centrs check $R --username $U --password $P --checks services --json
```

`data.checks[].findings` includes a `check/services/telnet-enabled` warning with
a `fix`. Top-level `warnings[]` carries the same code (roll-up).

### 9. `--ignore` suppresses a known finding back to green

```bash
centrs check $R --username $U --password $P --checks services \
  --ignore check/services/telnet-enabled --json
```

The warning no longer appears in `findings[]` or `warnings[]`; `ok: true`.

### 10. `--fail-on warning` fails the run but keeps the data

```bash
centrs check $R --username $U --password $P --checks services --fail-on warning --json
```

With telnet enabled: `ok: false`, exit `1`, and `error.code = check/verdict-failed`
with counts in `error.context` — **but** `data.verdict = "warn"`, `data.checks[]`,
and `data.profile` are all still present (constitution: the diagnostic carve-out;
a red result never discards what it measured). Re-running with
`--ignore check/services/telnet-enabled` returns `ok: true`, `data.verdict = "pass"`,
exit `0`.

## Capability pre-flight and transport

### 11. An unsupported path is skipped, not errored

Simulated against a device/version where a check's `requires` path is absent
(fixture or older CHR).

```bash
centrs check $R --username $U --password $P --checks routerboard --json
```

On CHR (no RouterBOARD) `routerboard` reports `ran: false`,
`skipReason` referencing capability/CHR — `ok` stays `true`, no raw protocol
error surfaces.

### 12. `--via` pins the transport with no silent downgrade

```bash
centrs check $R --username $U --password $P --via native-api --json
```

`meta.via = native-api`; the battery rode native-api. A pin to a transport that
cannot serve the battery errors with a `transport/*` code (constitution: never
silently downgrade across `--via`).

### 13. A slow check is bounded by `--check-timeout`

```bash
centrs check $R --username $U --password $P --checks traffic --check-timeout 2s --json
```

`traffic` (a ~10 s probe) is cut at 2 s: its entry carries a
`check/traffic/timed-out` finding and the run still returns rather than hanging.

## Custom check script

### 14. Custom scripts merge as synthetic checks (repeatable, `--yes`-gated)

Two policy scripts, one inline and one from a committed fixture, both required to
`:put` an `{errors,warnings,tips,metadata}` JSON envelope:

```bash
centrs check $R --username $U --password $P --yes --json \
  --check-script '{:put [:serialize to=json {"errors"=[:toarray ""];"warnings"=[:toarray ""];"tips"=[:toarray ""];"metadata"={"ipv6-disabled"=[/ipv6/settings/get disable-ipv6]}}]}' \
  --check-script-file test/integration/fixtures/check/policy.rsc
```

Each merges under its own `check/custom/<n>`. Without `--yes` the run errors
`usage/confirmation-required` (a custom script is a trusted, possibly-mutating
path); with it, the envelope carries a `check/custom-script/ran` audit
warning. A policy `error` in a script sets `data.verdict = "fail"` (and `ok:false`
at the default `--fail-on`), with the battery still present.

## `--save` (CDB reconcile, fixture-backed)

### 15. `--save` writes the port + derived facts to the CDB

Fixture CDB with a record for `$R` lacking `port=`/derived facts.

```bash
centrs check $R --username $U --password $P --save --yes --json
```

The record gains `port=` for the resolved transport (where non-default),
`board`/`version`/`software-id`, and an `updated=` stamp, through the `devices`
write layer. RouterOS is unchanged, and the SNMP community is **not** persisted.
Without `--save`, an identical run writes nothing to the CDB.

## Fan-out

### 16. Fan-out across a group

Fixture CDB group `lab` with two reachable CHRs.

```bash
centrs check --group lab --json
```

Locked `FanoutData` envelope (`data = { summary, targets[] }`); `targets[]` in
record order; exit `0` all-ok, `2` partial, `1` all-failed. A `--save --group lab`
without `--yes` errors, naming the blast radius.

## Reach signals and redaction

### 17. Reach reports latency and ARP presence

```bash
centrs check $R --username $U --password $P --preset reach --json
```

`data.profile` carries a host→router connect latency (RTT, ms) and an ARP-presence
fact for the target; `data.checks[].reach.metadata` lists the transports that
answered. No health-phase reads were issued.

### 18. Secrets are redacted from metadata

Precondition: an enabled SNMP community and `/ip/cloud` Back-To-Home on the CHR.

```bash
centrs check $R --username $U --password $P --checks snmp,cloud --json
```

`snmp` metadata reports version/scope/count but **omits the community string**;
`cloud` metadata keeps `dns-name`/`status` but **omits** `vpn-wireguard-client-config`
and the VPN keys. A full-envelope grep for the community string / WireGuard config
finds nothing.
