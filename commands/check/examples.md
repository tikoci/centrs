# check — examples

Each numbered example is an executable spec. Once `check` is implemented, the
integration test under `test/integration/check.test.ts` will run the CHR-backed
examples against a CHR booted by `@tikoci/quickchr`, and the offline examples
(flag parsing, `--list-checks`, fixture-backed `--save`) will run under
`test/unit/check.test.ts` — one assertion per example (example N ↔ assertion N).
Until then these are the **target**: if a line here is not exercised by a test
when the code lands, the test file is wrong; if a line passes only with
`--validate=false`, the **implementation** is wrong (see `docs/CONSTITUTION.md`).

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
`tip/reach/credentials-needed` is present.

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

### 10. `--fail-on warning` gates the exit code, not `ok`

```bash
centrs check $R --username $U --password $P --checks services --fail-on warning --json
```

With telnet enabled: the run stays **`ok: true`** with the full `data` present and
`data.verdict = "warn"`, but the process **exit code is `2`** (reachable, over the
chosen bar). Re-running with `--ignore check/services/telnet-enabled` gives
`data.verdict = "pass"` and exit `0`. (At the default `--fail-on error` the same
warning is a footnote — exit `0` — see example 19.)

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

Two policy scripts, one inline and one from a fixture the test will add (the path
shown is its planned location), both required to `:put` an
`{errors,warnings,tips,metadata}` JSON envelope. An unset channel is
`[:toarray ""]`, which RouterOS serializes as an empty array `[]` (not `[""]`) —
grounded on CHR 7.24rc1, where three `[:toarray ""]`-initialized channels
serialized as `[]`:

```bash
centrs check $R --username $U --password $P --yes --json \
  --check-script '{:put [:serialize to=json {"errors"=[:toarray ""];"warnings"=[:toarray ""];"tips"=[:toarray ""];"metadata"={"ipv6-disabled"=[/ipv6/settings/get disable-ipv6]}}]}' \
  --check-script-file test/integration/fixtures/check/policy.rsc
```

Each merges under its own `check/custom/<n>`. Without `--yes` the run errors
`usage/confirmation-required` (a custom script is a trusted, possibly-mutating
path); with it, the envelope carries a `check/custom-script/ran` audit
warning. A policy `error` in a script sets `data.verdict = "fail"` → exit `2` at
the default `--fail-on` (the run itself is `ok: true`; the battery is present).

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

## Presets, selection, and progressive control

### 19. Warnings do not fail the run at the default `--fail-on`

Precondition: telnet enabled (as example 8).

```bash
centrs check $R --username $U --password $P --json
```

A `services` warning is present, yet exit `0`: at the default `--fail-on error`,
`data.verdict = "warn"` is a footnote, not a failure. (Contrast example 10, which
raises the bar to `warning`.)

### 20. `--preset exposure` is a findings rollup, not extra reads

```bash
centrs check $R --username $U --password $P --preset exposure --json
```

`data.checks[]` contains only `services`, `certificates`, `snmp` (the preset
forces its members, including the normally-triggered `certificates`); no other
check ran and no path outside those three was read.

### 21. `--preset full` runs the opt-off checks

```bash
centrs check $R --username $U --password $P --preset full --json
```

`data.checks[]` additionally includes the `default: off` rows — `health`,
`packages`, `console`, `traffic`, `connections` — each `ran: true`.

### 22. `--deep` forces triggered checks even when their predicate is quiet

```bash
centrs check $R --username $U --password $P --deep --json
```

On an idle CHR (CPU low, `www-ssl` fine) `cpu-detail` and `certificates` still
ran (`ran: true`), where a bare run leaves them untriggered.

### 23. `--fast` suppresses progressive triggers

```bash
centrs check $R --username $U --password $P --fast --json
```

No `trig` check appears in `data.checks[]` regardless of what the default battery
flagged; only cheap default checks ran.

### 24. `--tag` filters to tagged checks

```bash
centrs check $R --username $U --password $P --tag hardware --json
```

Only on-by-default checks carrying the `hardware` tag ran (e.g. `resource`,
`routerboard`); untagged checks are absent. (The tag taxonomy is provisional —
see README.)

## Suppression

### 25. `--ignore <checkId>` mutes findings but keeps metadata; `--skip` drops the check

```bash
centrs check $R --username $U --password $P --checks services --ignore services --json
```

`services` still appears in `data.checks[]` with `metadata` populated, but its
`findings[]` is empty and nothing rolls up to top-level `warnings[]`. By contrast
`--skip services` removes the check entirely (no entry, no metadata).

### 26. `CENTRS_CHECK_IGNORE` suppresses via env (precedence)

```bash
CENTRS_CHECK_IGNORE=check/services/telnet-enabled \
  centrs check $R --username $U --password $P --checks services --json
```

Same effect as passing `--ignore check/services/telnet-enabled`; the winning
suppression source is reported in `meta.settings`. A `--ignore` arg for a
different code composes on top (both suppressed).

### 27. `--fail-on never` never fails the run

Precondition: a custom script that emits an `error` finding (as in example 14).

```bash
centrs check $R --username $U --password $P --yes --fail-on never --json \
  --check-script '{:put [:serialize to=json {"errors"=[:toarray "policy breach"];"warnings"=[:toarray ""];"tips"=[:toarray ""];"metadata"={}}]}'
```

`data.verdict = "fail"` but exit `0`; the error finding is still reported. This is
the pure-data-collection mode #149's IP-scan uses.

### 28. Unknown check name → did-you-mean (offline)

<!-- cspell:ignore servces -->

```bash
centrs check $R --checks servces --username $U --password $P
```

A `usage/*` error names `servces` as unknown and lists the closest catalog ids
(`services`) — the shared did-you-mean behavior (constitution / commands help).
Exit non-zero, no network IO.

## Fan-out and the write gate

### 29. Fan-out reports partial success with exit 2

Fixture CDB group `lab`: one reachable CHR, one unreachable host.

```bash
centrs check --group lab --json
```

`FanoutData`: the reachable target's inner envelope is `ok: true`, the unreachable
one `ok: false` (`transport/*`); outer orchestration `ok: true`, process exit `2`.

### 30. `--save` fan-out requires `--yes`

```bash
centrs check --group lab --save --json
```

Without `--yes` it errors before writing, naming the blast radius (how many CDB
records would change); adding `--yes` reconciles each target's record.

## L2 and MNDP (CHR L2 bridge)

### 31. A bare-MAC target runs the battery over mac-telnet

CHR-gated: needs the `socket-connect` L2 bridge (see `commands/discover/README.md`).
`$MAC` is the CHR's ether MAC.

```bash
centrs check $MAC --username $U --password $P --json
```

With no IP path, the battery rode mac-telnet (`meta.via = mac-telnet`) as one
consolidated script (Execution model); the health checks are `ran: true`.

### 32. MNDP enrichment survives an auth failure

CHR-gated (L2 bridge). Precondition: wrong password.

```bash
centrs check $R --username $U --password wrong --json
```

`reach` still returns `ran: true` and `data.profile` carries MNDP-advertised
`identity`/`version`/`platform`/`board`; the health checks are `ran: false` (auth
failed). An auth error finding is surfaced, but the free MNDP facts are not lost.
