# check

Run a battery of health/diagnostic **checks** against a router and return
findings (errors / warnings / tips) plus judgment-free, **allowlisted** metadata
in one envelope — a device *doctor* that also hands later `retrieve` / `execute`
/ `api` calls the context they'd otherwise splunk for themselves.

Status: `designed` over `rest-api`, `native-api`, `ssh`, and `mac-telnet` (the
execute-capable transports the battery can ride); `snmp` and
`romon` / `winbox-terminal` stay `not-started`. See `docs/MATRIX.md` for the row.
Load-bearing rules — envelope, errors, settings precedence, identity, validation,
protocol selection, fan-out — live in
[`docs/CONSTITUTION.md`](../../docs/CONSTITUTION.md); the `(constitution: …)`
notes below point there rather than restating them.

## What changed (this is a revision, not greenfield)

The prior stub scoped `check` as a **reachability probe** — "probe a router and
report which management paths are usable" — with the health data an afterthought
behind `--fix`. That reachability probe survives, but as *one phase* of a richer
command, and the CDB-write flag is now `--save` (it never touches the router; see
[`--save`](#--save)). The old L2 rationale the stub stated —

> L2 probing (mac-telnet reachability / ARP) is **opt-in, off by default** …
> It needs L2 adjacency and is slower, so IP-level probing (rest/native/ssh)
> stays the default.

is **preserved but re-grounded** (see [L2 timing experiment](#l2-timing-experiment)):
under the new model mac-telnet is not a parallel "L2 reachability" default — it is
a *transport the whole battery can ride* (via `execute`) when it is the only way
in (a bare-MAC target, or IP paths that failed). The opt-in default holds; the
experiment measures the cost that justifies it.

## Where `check` sits

The built-in `check` battery is **read-only** — it never writes RouterOS. The
lone exception is `--check-script*`, a **trusted** escape hatch that *can* mutate
the router (see [Custom check script](#custom-check-script)); `--save` reconciles
centrs's own CDB, never the device (see [`--save`](#--save)).
Think `doctor`: a list of self-describing checks runs, each yields the standard
finding channels, and configuration lets a caller silence known-and-accepted
findings to reach a green result. Its probe machinery is deliberately reusable —
`discover`'s future IP-scan (#149) iterates `check` per host, and the metadata it
collects seeds TikTOML (#137).

## Two phases

- **Reach** — TCP reachability per protocol, host→router connect **latency**
  (RTT) captured from that same probe, an auth check on whichever answered, plus
  **ARP presence** as an L2-adjacency fact. Creds are *optional to start*: a
  no-cred `check` still reports reachability + latency and tips that credentials
  are needed for the health phase. When auth fails entirely (or the target is a
  bare MAC), reach enriches the profile **for free** from the MNDP cache —
  advertised identity / version / platform / board / software-id — best-effort on
  L2 adjacency (the codec `discover` already ships). This is the slice a subnet
  sweep wants (`--preset reach`), not the full battery against a /24.
- **Health** — over the best working transport (constitution: protocol
  selection), run the battery of RouterOS reads → findings + metadata. The reads
  are ordinary `print`/`get` commands, so they ride `retrieve` / `api` on
  rest/native **and** ride `execute` on ssh / mac-telnet — the battery is
  transport-portable, which is exactly what lets mac-telnet serve as a slow
  full-battery path. `resource` runs **first** (see
  [Execution model](#execution-model)).

## Checks are modules, not a conditional block

Each check is an independent, self-describing unit
(`{ id, title, description, tags, phase, cost, defaultOn, requires, dependsOn, run }`)
registered with an orchestrator. That registry is what powers `--list-checks`
(list **and explain** every check), clean extension (add a module, don't refactor
the flags), and the **progressive** default: expensive checks run only when a
cheaper one flags something.

- `cpu-detail` runs iff `resource` reported high CPU load.
- `certificates` runs iff `services` found `www-ssl` disabled or a cert near
  expiry.
- Opt-off checks (`traffic`, `health`, `packages`, `connections`) never run
  unless named (`--checks`) or pulled in by a preset.

"Smart" here is a first cut, expected to be tuned against real devices over time.
Because slow or hung probes are the main risk to usefulness, every check runs
under a per-check timeout (`--check-timeout`, default `8s`); a check that exceeds
it yields a `check/<id>/timed-out` finding and the battery continues with partial
results rather than hanging.

## Execution model

The naive "15 checks → 15 calls" plan is fine over rest-api / native-api (calls
pipeline cheaply) but **excruciating** over ssh / mac-telnet, where every call
pays session setup. So the orchestrator batches per **round**, not per check:

1. **Foundational read.** `resource` (version / arch / board) runs first — its
   output is what the capability pre-flight needs (below).
2. **Round 1.** All selected static reads are issued together. Over an
   execute-transport centrs composes them into **one consolidated `:put`-JSON
   script** (one `:serialize to=json` object — the `tojson` helper in the
   grounding sample) that returns a single object in one session; over
   rest/native they pipeline as individual calls.
3. **Round 2 (only if triggered).** Progressive checks (`cpu-detail`,
   `certificates`, …) whose predicate fired are collected and issued as **one**
   additional batched round — never a round-trip per triggered check.

This keeps the mac-telnet full battery to ~two sessions instead of ~fifteen, and
the batched script only pulls **allowlisted fields** (proplist / explicit
attributes), which also bounds payload and avoids scraping secrets.

## Findings, severity, and reaching "green"

Each check emits into the standard channels (constitution: result envelope),
plus a metadata block:

| Channel    | Meaning for `check`                                                        |
| ---------- | -------------------------------------------------------------------------- |
| `error`    | Blocks the check's purpose (no transport reachable, auth fails everywhere). |
| `warning`  | A real anomaly about *this* device (telnet/ftp enabled, disk < 16 MB free, EOL version, cert expiring, SNMP community open to `0.0.0.0/0` or `::/0`). |
| `tip`      | Advice, not a fault (enable `www-ssl`; reverse-proxy on 443, here's the mapping). |
| `metadata` | Facts, no verdict (arch, board, version + channel, ddns-name, license level, port map, latency, health sensors). Feeds `data.profile`. |

Finding codes are slash-namespaced (constitution: error model):
`check/<checkId>/<slug>` for errors/warnings, `tip/<checkId>/<slug>` for tips —
so a caller can suppress one finding, or a whole check's findings, by code.

**Verdict, `ok`, and exit code.** `check` computes `data.verdict` ∈ `pass` /
`tip` / `warn` / `fail` (the max finding severity after suppression). A run that
reached a transport and executed the battery is **`ok: true`** and always carries
`data` — an unhealthy device is a *finding*, not a command failure. Only a genuine
failure (no transport reachable, auth fails on every transport, orchestration
error) is `ok: false` (`error`, no data), matching the shared envelope.

Health gates **the exit code**, derived from the verdict vs `--fail-on` — a
per-command rule, like fan-out's granular codes:

- `--fail-on <error|warning|tip|never>` (default `error`) is the threshold.
- Exit `0` when the verdict is **below** it (at the default, warnings and tips are
  footnotes → `0`); exit `2` when the run is `ok:true` but the verdict
  **met/exceeded** it (reachable, but unhealthy per the chosen bar); exit `1` on
  an `ok:false` command failure. `--fail-on never` forces exit `0`.

`--ignore <code|checkId>` (repeatable) suppresses matching findings so a
known-and-accepted condition stops counting toward the verdict and stops
cluttering output; `--ignore <checkId>` mutes a check's *findings* but keeps its
metadata, while `--skip <checkId>` doesn't run it at all. Suppression follows the
normal settings precedence (constitution): `--ignore` arg → `CENTRS_CHECK_IGNORE`
env → per-device CDB `check-ignore=` comment-kv. The CDB override lets a caller
durably accept findings without re-passing flags (adding `check-ignore=` to the
comment-kv allowlist is a follow-up against `commands/devices/README.md`).

### Metadata is allowlisted, not raw

Built-in checks never dump raw `as-value` output into `metadata` — each maps a
**typed, allowlisted** subset, and credential-class fields are omitted or
redacted before entering the envelope (and, if an error ever mentions them,
listed in `redactable_fields`; constitution: error model). Concretely, from the
grounding sample: `/ip/cloud` keeps `dns-name` / `status` / `back-to-home-vpn`
but **drops** `vpn-wireguard-client-config`(-`qrcode`) and the VPN keys;
`/snmp/community` reports version / scope / count and **redacts the community
string** (it is a credential); `/certificate` keeps names / validity / fingerprint
and never key material. A custom check (below) owns its own output and is exempt
from this allowlist — that is part of why it is a trusted, gated path.

## Check catalog (first cut)

Grounded in the RouterOS command set surveyed for this spec — each row's `reads`
column names its source command. `default`: `on` runs in the smart battery;
`trig` runs only when a dependency flags it; `off` runs only when named/preset.

| id             | phase  | default | emits          | reads                              |
| -------------- | ------ | ------- | -------------- | ---------------------------------- |
| `reach`        | reach  | on      | error/tip/meta | TCP + auth per protocol; host→router RTT; ARP presence; port map; MNDP-fact enrichment on auth-fail; tips `credentials-needed` when creds are absent |
| `resource`     | health | on¹     | warn/tip/meta  | `/system/resource` — version vs long-term, arch/board (**foundational, runs first**), cpu/mem/disk vs limits, disk < 16 MB, short uptime |
| `services`     | health | on      | warn/tip/meta  | `/ip/service` — ports, `vrf`, `allowed-address`, disabled/invalid, `www-ssl` off, telnet/ftp on, reverse-proxy on 443, **CDB `port=` mismatch** |
| `cloud`        | health | on      | tip/meta       | `/ip/cloud` — ddns-name, `ddns-enabled=auto` semantics; Back To Home fields may be absent on stock/trial CHR |
| `dns`          | health | on      | warn/meta      | `/resolve` — warn (not error) if resolution fails |
| `ipv6`         | health | on      | tip/meta       | `/ipv6/settings` — `disable-ipv6` |
| `snmp`         | health | on      | warn/tip/meta  | `/snmp/community` — version/scope/count; community string **redacted**; warns on unrestricted enabled read scope (`0.0.0.0/0` or `::/0`) or default `public` with `security=none`; tips toward `snmp-community=` for future `retrieve --via snmp` |
| `certificates` | health | trig    | warn/meta      | `/certificate` when `www-ssl` off / near expiry |
| `cpu-detail`   | health | trig    | warn/meta      | `/system/resource/cpu` when `resource` load is high |
| `routerboard`  | health | on²     | tip/meta       | `/system/routerboard` — firmware vs routeros; absent on CHR |
| `license`      | health | on³     | warn/meta      | `/system/license` — `level`; matters most on CHR |
| `health`       | health | off     | meta-only      | `/system/health` — variable shape, no verdicts |
| `packages`     | health | off     | meta           | `/system/package` — installed/available + arch |
| `console`      | health | off     | tip/meta       | `/system/console` — serial exists → tip when all paths fail |
| `traffic`      | health | off     | meta           | `/interface/monitor-traffic` — **~10 s**, slow |
| `connections`  | health | off     | meta           | firewall connection `count-only` |

¹ foundational — always runs first. ² on for RouterBOARD hardware, auto-skipped
on CHR. ³ on for CHR, informational on hardware.

`--preset` bundles: `reach` (reach phase only), `health` (reach + on-by-default
health), `full` (every check including opt-off — slow), and `exposure` — a
**rollup** over the findings `services` / `certificates` / `snmp` already
produce. `exposure` reads **no extra paths** and does **no vulnerability or
misconfiguration scanning**; it is a filtered access-surface view (insecure
service enabled, weak/expiring cert, open community), named to avoid implying a
security audit it does not perform. `--tag <t>` filters by tag; `--deep` forces
triggered/enrichment checks; `--fast` suppresses progressive triggers.

## Flags

The whole command is spec-tier (`designed` — nothing is implemented yet), so
this table is the design, not a reference; once `check` lands, its
implemented flags will be generated into `docs/CLI.md` like every other
command's.

| Flag | Behavior |
| ---- | -------- |
| `--preset <name>` | `reach` / `health` (default) / `exposure` / `full`. |
| `--checks <a,b,c>` | Run exactly these checks (+ their `dependsOn`). |
| `--skip <a,b,c>` | Run the selection except these. |
| `--tag <t>` | Restrict to checks carrying tag `t` (repeatable). |
| `--deep` / `--fast` | Force / suppress progressive (triggered) checks. |
| `--list-checks` | Print the catalog with descriptions; no network IO. |
| `--fail-on <severity>` | Verdict threshold that gates the **exit code** (`0`/`2`), not `ok`. Default `error`. |
| `--ignore <code\|checkId>` | Suppress matching findings (repeatable). |
| `--check-timeout <dur>` | Per-check timeout. Default `8s`. |
| `--save` | Reconcile the CDB from what was probed (write-shaped, gated). |
| `--check-script <str>` / `--check-script-file <file>` | Custom check; both **repeatable** (see below). Requires `--yes`. |
| `--via <protocol>` | Pin the battery transport. No silent downgrade (constitution). |
| `--l2` | Opt into L2 (mac-telnet / ARP) probing in the reach phase even when IP paths answer. Off by default — L2 is opt-in (see [L2 timing experiment](#l2-timing-experiment)); also implied by a bare-MAC target or `--via mac-telnet`. |
| `--group` / `--where` / `--all` / `--default` / `--concurrency` | Fan-out (see below). |
| target/auth | `--host`, `--port`, `--username`/`-u`, `--password`, `--insecure`, `--timeout`, `--resolve`, `--cdb-file`, `--cdb-password` — same resolver as `retrieve`/`execute`. |

## Custom check script

The built-ins stay minimal on purpose; `--check-script` / `--check-script-file`
is the escape hatch for site- or policy-specific checks. Both are **repeatable**,
so an agent can compose checks from several sources; each is merged as its own
synthetic check (`check/custom/<n>`). A script must `:put [:serialize to=json …]`
an envelope-shaped result:

```json
{ "errors": [], "warnings": [], "tips": [], "metadata": {} }
```

**Trust and gating.** A custom script runs through `execute`'s script-mode syntax
gate (`:put [:parse]`; structured commands add inspect, but arbitrary script mode
does not). execute only classifies *structured* add/set/remove as write-shaped —
arbitrary **script mode is not caught**, so a custom script *can* mutate RouterOS.
It is therefore a **trusted** path: centrs requires `--yes` to run any
`--check-script*` and attaches a `check/custom-script/ran` audit warning to the
envelope. RouterOS-side ergonomics (outer block for `:local`, appending to arrays,
dashed-variable quoting, bool-vs-`yes|no` enums) are demonstrated in
`examples.md`.

## Capability pre-flight (ties to #129)

RouterOS commands vary by version and arch, so a check must not blow up on a
device that lacks the path it reads. `resource` runs first and yields the **live**
version / arch / board; the orchestrator pre-flights each remaining check's
`requires` paths against that live value (falling back to the stored
`version` derived fact, or one batched `/console/inspect` when neither is
conclusive), and marks an unsupported check `ran:false` with
`skipReason:"unsupported-on-<version>"` — a graceful skip, not a raw protocol
error. Grounding is offline-first against restraml's historic `inspect.json`
(`jq`), CHR only to confirm. `check` is the first multi-consumer of the #129
pre-flight utility (alongside `transfer mkdir`).

## `--save`

`--save` (was `--fix`; renamed because it never fixes the *router*) is the only
write-shaped path, and it writes **centrs's CDB, never RouterOS** — matching
`discover --save`. After the battery authenticates over one transport it
reconciles the resolved device's record in one pass (through the `devices` write
layer — the only CDB writer), gated like any write (`--yes` / confirm; `--force`
for a multi-record selection):

- **Connection metadata** — the resolved/`via` transport's `port=` (learned from
  `services`) when non-default, so later calls connect directly. The CDB carries a
  single `port=`, so the *full* per-protocol port map stays in `data.profile.ports`
  (queryable); persisting per-protocol ports needs new `devices` keys — a tracked
  follow-up, not this pass.
- **Derived facts** — `board`, `version`, `software-id`, `updated=` (the same
  queryable-but-stale keys `devices add/set --check` and `discover --save`
  populate; constitution: identity — derived facts never override a live read).
- **Newly-learned lookup keys** — `mac=` / `identity=` / `ip=` when the record
  lacks them.

**SNMP boundary.** The `snmp` check *reports* a usable community (redacted) and
*tips* toward storing it — but `--save` does **not** silently persist a community,
because it is a credential and there may be several. Persisting it is an explicit,
separate act (`devices set <t> snmp-community=…`, consumed by the future
`retrieve --via snmp`); whether `--save --with-snmp` should opt into that is an
open item below.

Plain `check` (no `--save`) writes nothing.

## Fan-out

`check` is a clean per-target pipeline, so it fans out like `retrieve` / `execute`
/ `api` (constitution: target selection). Any selector (`--group` / `--where` /
`--all` / `--default`) or more than one positional switches to the locked
`FanoutData` envelope (`data = { summary, targets[] }`) with the granular
`0`/`2`/`1` exit code. Because an unhealthy device is now `ok:true` per target,
the fan-out exit code tracks **orchestration** (inner `ok`), not health — so the
`summary` aggregates per-target verdicts (a `verdicts` tally) and each target's
`data.verdict` stays in its inner envelope, which is how #149's IP-scan reads
per-host health. A multi-target `--save` is a write and needs `--yes`. This
per-host fan-out is exactly the machinery `discover`'s IP-scan (#149) will drive.

## Output

Standard envelope (constitution: result envelope). `data` has three parts:

- `data.verdict` — `pass` / `tip` / `warn` / `fail`, the max finding severity after
  suppression (gates the **exit code** via `--fail-on`; `ok` stays `true` when the
  command ran).
- `data.checks[]` — per-check detail: `{ id, ran, skipReason?, verdict, findings[], metadata, timing }`.
- `data.profile` — a consolidated, flat **device profile** (board, arch, version,
  channel, identity, ddns-name, license-level, `ports{}`, latency, reachable
  transports …) assembled from the allowlisted check metadata. This is the
  reusable "device-type" surface for #149 and #137. **Its field set is emitted
  best-effort now but is not yet normative** — TikTOML (#137) / IP-scan (#149)
  will freeze the schema; until then treat `data.profile` as additive and don't
  hard-code its shape.

Check-level warnings/tips also roll up into the top envelope's `warnings[]` /
`tips[]` so a consumer that ignores `data.checks[]` still sees them.

## L2 timing experiment

Required evidence for this spec (issue #136), re-scoped to the new model and
**run** on a real CHR via `@tikoci/quickchr` (mac-telnet uses the `socket-connect`
host-side L2 bridge that `discover` / mac-telnet cells already use — see
`commands/discover/README.md`, L2 validation policy):

- **Measured:** mac-telnet session setup + a representative health-battery round
  (the consolidated `resource` + `services` script) vs the same battery over
  rest-api / native-api on the same CHR.
- **Decided:** whether L2 is cheap enough to belong in the *default* reach sweep,
  or stays opt-in (enabled by a MAC target, `--via mac-telnet`, or `--l2`).

Findings, run 2026-07-02 against quickchr CHR `7.23.1 (stable)` on local macOS
x86_64. Each row is five measured samples after one warm-up; each sample creates
a fresh adapter/session, matching the per-target battery cost.

| Path | Median | Samples |
| ---- | ------ | ------- |
| rest-api direct `resource` + `services` reads | 4 ms | 4, 4, 4, 4, 4 |
| native-api direct `resource` + `services` reads | 129 ms | 128, 130, 129, 131, 129 |
| rest-api consolidated execute script | 3 ms | 3, 3, 3, 3, 3 |
| native-api consolidated execute script | 130 ms | 130, 131, 131, 121, 118 |
| mac-telnet consolidated execute script | 10,888 ms | 10,888, 10,885, 10,932, 10,880, 10,895 |

Verdict: preserve L2 as **opt-in**. mac-telnet is useful as a rescue/full-battery
transport when it is the only way in, but a single consolidated session is ~10.9s;
a two-round progressive battery is roughly double that. That is not acceptable
as a default per-host cost for #149 subnet sweeps.

## Definition of done

`designed` on the strength of this README (intent + flags). A protocol cell
advances to `CHR-passed` only when every example in `examples.md` runs green
against a real CHR through `bun run test:integration`. See
[`docs/CONSTITUTION.md`](../../docs/CONSTITUTION.md) for the full done rule.

## Open questions / decisions made this round

- **Default breadth = smart battery** (reach + on-by-default health +
  progressive), biased against slow/hang via `--check-timeout`. "Smart"
  triggering thresholds are a first cut to tune against devices.
- **Red-verdict model** = `ok:true` with `data` retained; the health verdict
  (`data.verdict`) gates the **exit code** (`0` pass / `2` unhealthy / `1` command
  failure), like fan-out's granular codes. No envelope carve-out — the shared
  discriminated-union envelope is unchanged.
- **Reach latency = host→router RTT** (+ ARP presence); router→internet health is
  the `dns` check's job.
- **`exposure` (not `security`) is a rollup preset** — no extra reads, no
  vulnerability/misconfiguration scanning; named honestly.
- **`--save` (not `--fix`)** — CDB-only, consistent with `discover --save`.
- **Metadata is allowlisted + secrets redacted**; batched execution over
  execute-transports; `resource` foundational-first for capability gating; custom
  scripts repeatable + `--yes`-gated + audited.
- **Suppression persists** per-device (CDB `check-ignore=`) and via env.
- **SNMP open threshold** includes unrestricted enabled read scopes
  (`0.0.0.0/0` or `::/0`); stock CHR 7.23.1 exposes enabled `public` with
  `security=none` and `addresses=::/0`, so that counts as a warning.
- **`data.profile` shape not yet normative** — deferred to #137/#149.
- **Naming is provisional** — flag/check/preset names here are for the concept;
  rationalize holistically before code.
- **Still open:** whether `--save` should grow `--with-snmp` to persist a
  community as `snmp-community=` comment-kv (and adding that key to the `devices`
  allowlist); whether `--save` should also capture `ddns-name`.
