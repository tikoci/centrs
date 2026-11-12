# Matrix

This file owns **capability status, the current track, parked themes and
nits**. The command × protocol grid covers live operations; the
[Components](#components) table covers the parts that span commands: offline
analysis, transports, target sources, frontends and peer measurement. A
capability's acceptance criteria live in its `commands/<name>/README.md`, or in
`components/<name>/README.md` for a component; GitHub issues own the actionable
tasks that satisfy them.

Start with [Current track](#current-track), then the command's README,
examples, and linked issue. Verification follows `docs/CONSTITUTION.md` →
Done definition. A completed implementation slice is not proof that the whole
capability is complete.

## Cell states

| State          | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| `—`            | Not applicable / out of scope for this protocol                 |
| `not-started` | No code and no design                                           |
| `designed`     | Its spec (`commands/<name>/README.md` or `components/<name>/README.md`) describes intent and flags |
| `coded`        | Implementation exists in `src/`                                 |
| `verified`     | Offline capability meets its spec's baseline acceptance criteria in full (examples, contract checks, measured/consumer gates, and CHR-grounded evidence). |
| `CHR-passed`   | Every example in its spec's `examples.md` is green on CHR; a component without one names the command examples it rides |

A cell advances only with the matching evidence in the same change.

`verified` applies to offline capabilities; it does not advance a live protocol
cell. Existing `CHR-passed` fixture-backed `devices`/`settings` entries retain
their command-specific evidence contracts.

## Grid

| Command  | rest-api      | native-api    | ssh           | mac-telnet    | mndp          | romon         | winbox-terminal |
| -------- | ------------- | ------------- | ------------- | ------------- | ------------- | ------------- | ---------------- |
| retrieve | `CHR-passed`  | `CHR-passed`  | —             | —             | —             | —             | —                |
| api      | `CHR-passed`  | `CHR-passed`  | —             | —             | —             | —             | —                |
| execute  | `CHR-passed`  | `CHR-passed`  | `CHR-passed`  | `CHR-passed`  | —             | `not-started` | `not-started`    |
| terminal | —             | —             | `CHR-passed`  | `CHR-passed`  | —             | —             | —                |
| transfer | `CHR-passed`  | `CHR-passed`  | `CHR-passed`  | —             | —             | —             | —                |
| devices  | —             | —             | —             | —             | —             | —             | —                |
| discover | —             | —             | —             | —             | `CHR-passed`  | —             | —                |
| check    | `designed`    | `designed`    | `designed`    | `designed`    | `not-started` | `not-started` | `not-started`    |
| explain  | `CHR-passed`  | `CHR-passed`  | —             | —             | —             | —             | —                |
| settings | —             | —             | —             | —             | —             | —             | —                |

## Status pointers

Detailed command contracts live in `commands/<name>/README.md`; example evidence
lives in `commands/<name>/examples.md` and the named tests. Keep task history
and implementation sequencing in the linked issues.

- `devices` is transport-less, so its row stays `—`; command state is
  `CHR-passed` by fixture-backed integration tests in `test/integration/devices.test.ts`.
- `settings` is transport-less, so its row stays `—`; command state is
  `CHR-passed` by fixture-backed integration tests in `test/integration/settings.test.ts`.
- `retrieve`, `api`, `execute`, and `transfer` share the target-selection and
  fan-out contracts from `docs/CONSTITUTION.md`; command-specific boundaries and
  evidence are in their command READMEs and integration tests.
- `execute --cmr` (#450) is not a grid column: CMR is a selection source, and
  its controller transports are the `execute` rest-api/native-api cells. Its
  row is in [Components](#components); evidence and the builds it follows are
  in `components/cmr/README.md`.
- `api --stream` absorbs the former `stream`/`tail` surface; native-api stream
  details are in `commands/api/README.md` and `src/protocols/native-api.ts`.
  #399 extends it to incremental command replies and truthful terminal outcomes.
  #402 makes it literal: following is the `<menu>/listen` endpoint, every wire
  reply (`!empty` included) is a line, and what RouterOS will not report
  (filtered or projected change feeds) is a tip, not a rewrite.
- `retrieve --follow` (#396) is the stateful follow over native-api: A1
  bootstrap, `synced`, live frames, and an `.id` sweep for removals RouterOS
  does not send. Single-target; `CHR-passed` by
  `test/integration/retrieve-follow.test.ts` (FL1–FL9, 7.23.7 and 7.24.5).
  Filtered follow (#397) uses device-evaluated changed-id membership, guarded
  against stale replies; `test/integration/retrieve-filtered-follow.test.ts`
  covers FQ1–FQ5 on 7.23.8 and 7.24.5, including projected predicates, both membership directions,
  minimal deletes, silent predicate exits and bootstrap/live churn.
- `retrieve --sample <interval>` repeats the one-shot read on a timer, one
  line per complete read, over rest-api or native-api: the answer for counters
  and state `listen` never reports. RouterOS's `print interval=` was measured
  and not used (no end-of-tick marker). Single-target; `CHR-passed` by
  `test/integration/retrieve-sample.test.ts` (SA1–SA6, 7.23.7 and 7.24.5).
- `retrieve --query` (#397) filters rows on the router with the `print where`
  grammar, compiled to the API query; `api --query` shares it. One-shot,
  `--sample` and fan-out; `CHR-passed` by
  `test/integration/retrieve-query.test.ts` (QY1–QY7, QA1–QA2, 7.23.7 and
  7.24.5), whose QY1 checks the rows against RouterOS's own `find where`.
- `retrieve --wait` / `--until` / `--until-empty` (#364) return one bounded
  readiness/condition result over REST or native-api, with elapsed time,
  attempts and completed observations. `test/integration/retrieve-wait.test.ts`
  covers WT1–WT7 on 7.23.8 and 7.24.5, including real reboot readiness and a
  two-CHR OSPF adjacency.
- `discover / mndp` is grounded by `commands/discover/README.md`,
  `src/data/mndp.ts`, `src/data/mndp-cache.ts`, and
  `test/integration/discover.test.ts`.
- `check` is `designed` (`commands/check/README.md`): a reach + health battery
  whose reads ride the execute-capable transports (rest-api/native-api/ssh/
  mac-telnet), so those four cells are `designed`; `mndp`, `romon` and
  `winbox-terminal` stay `not-started`. Its reach half (finding which services
  answer, and on which ports) moves to `devices` onboarding
  ([Devices and onboarding](#devices-and-onboarding)); the health battery stays
  here. The L2-default timing evidence (#136) is recorded in the README before
  the cells advance past `designed`.
- `explain`'s two `CHR-passed` protocol cells are the whole live capability
  (#236). `explain <router> '<input>'` collects read-only `:parse`, highlight
  and child argument-name evidence (#491), and `--schema`/`--complete` describe
  paths and complete at a cursor (#492). Live value types (#225) fill
  `observedType` from visible `:parse` conversions and `schemaType` from
  argument `syntax`. Examples 7–16, 19, 24, 48 and 52–53 pass on REST and
  native API in `test/integration/explain-live*.test.ts`, on stable 7.24.5 and
  long-term 7.23.8. `runtimeAcceptance` stays `not-proven`. Offline analysis
  has its own row in [Components](#components). The generated structure tables
  `src/explain/menus.ts` and `src/explain/catalog.ts` keep analysis offline;
  their ownership and regeneration contracts live in `commands/explain/README.md`.
- `transfer / ssh` means the SFTP-backed transfer method. Deferred file-transfer
  methods such as `scp`, `fetch`, and `ftp` are tracked in
  `commands/transfer/README.md`; `fetch` is not a grid column.
- SSH grounding for `execute` and `terminal` lives in
  `commands/execute/README.md`, `commands/terminal/README.md`,
  `src/protocols/ssh.ts`, `src/protocols/sftp.ts`, and `src/terminal.ts`.
- MAC-Telnet grounding for `execute` and `terminal` lives in
  `commands/execute/README.md`, `commands/terminal/README.md`, and the
  `src/protocols/mac-telnet*.ts` module headers.

## Components

Parts of centrs that span commands. A component has a
`components/<name>/README.md` when its contract has no single command README to
live in (`components/AGENTS.md`); the others point at their code and command
READMEs. Cell states are the same as the grid's.

| Component | Kind | State | Contract and evidence |
| --------- | ---- | ----- | --------------------- |
| explain / offline baseline | analysis | `verified` | `commands/explain/README.md` → Offline baseline acceptance; offline examples in `test/unit/explain.test.ts`, focused `test/unit/explain-*` suites, and CHR captures under `test/fixtures/explain/`. The token partition is scored against device `highlight` by `test/unit/explain-highlight-agreement.test.ts` and `test/fixtures/explain/highlight-agreement.json`. The public entry is `@tikoci/centrs/explain`; its dependency boundary and executed browser-consumer proof are gated by `test/unit/explain-browser-entry.test.ts` (`bun run explain:browser-consumer`). #322's fixed-size 16× depth guard and deterministic structural-work guards close the bounded-execution criterion. Closed history: #90 (correctness, token agreement #264/#263, consumer verification, bounded execution #322). Follow-on work: [Explain for agents](#explain-for-agents). |
| cmr | target source | `CHR-passed` (7.26beta1) | `components/cmr/README.md`: the surfaces that touch CMR, `test/integration/execute-cmr.test.ts`, and what is known per beta. Later betas are not covered yet (#527). |
| native-api | transport | grid | Used by `retrieve`, `api`, `execute`, and `transfer`; wire facts in `src/protocols/native-api.ts`. |
| ssh / sftp | transport | grid | Used by `transfer`, `execute`, and `terminal`; facts in `src/protocols/ssh.ts`, `src/protocols/sftp.ts`, and `src/terminal.ts`. |
| mac-telnet | transport | grid | Used by `execute` and `terminal`; facts in `src/protocols/mac-telnet.ts`, `src/protocols/mac-telnet-console.ts`, `src/protocols/mtwei.ts`, and `src/protocols/adapter.ts`. |
| ts-api | frontend | `CHR-passed` | `src/index.ts`: the root TypeScript library surface; everything else adapts it. |
| cli | frontend | `coded` | `src/cli/`: every command in `cliCommands` (`src/cli.ts`) is wired: `retrieve`/`execute`/`api`/`transfer`/`terminal`/`explain`/`devices`/`discover`/`btest`/`mcp`/`settings`, plus the `upload`/`download` shortcuts. |
| mcp | frontend | `CHR-passed` | `commands/mcp/README.md` and `test/integration/mcp.test.ts`: the scoped-verb stdio server, its CDB-as-allowlist safety model and the `mcp=rw` + `confirm:true` write gate (examples 1–10). |
| remote (web / proxy) | frontend | `not-started` | No code. Its shape follows consumer work ([routeros-muse, app-t3code](CONSTITUTION.md#consumers)); a TUI is further out. |
| btest / server | peer measurement | `CHR-passed` | `test/integration/btest.test.ts`; `commands/btest/README.md`. |
| btest / client | peer measurement | `CHR-passed` | `test/integration/btest-client.test.ts`; `commands/btest/README.md`. |

- **Offline analysis** opens no protocol connection and is usable on its own.
  It exposes structure, diagnostics, token partitions, symbols and
  flow-sensitive value facts. `verified` records its acceptance evidence; it
  is not a parser-coverage score and does not advance either live `explain`
  cell. Live probes (#236), MCP response alignment and configuration policies
  are separate work, not prerequisites.
- **Transports** show `grid` because their state is the command cells they
  carry. Their `src/protocols/*.ts` module headers are the single home for
  wire-format, auth, and delivery facts; do not expand this file with
  per-packet or per-router findings.
- **Frontends** adapt the shared core. A frontend advances to `CHR-passed` only
  when every example in its spec (`commands/<surface>/examples.md`, where one
  exists) is green via `bun run test:integration`.
- **btest** is the MikroTik bandwidth test (TCP/UDP port 2000), a peer
  measurement rather than a RouterOS-command transport, and is exempt from the
  RouterOS command-validation gate. Wire, auth, TCP/UDP and CI caveats live in
  `commands/btest/README.md` and the `src/protocols/btest*.ts` /
  `src/protocols/ec-srp5.ts` module headers.

## Current track

The maintainer sets this list, and it is the only thing that schedules work.
An open bug can be fixed without being selected; nothing requires picking one
up. Unfinished grid cells and parked themes do not preempt the track. The same
holds for [consumer repos](CONSTITUTION.md#consumers): a bug they file is fixed
like any bug, and a feature they need is noted on its parked theme until the
maintainer adds it here.

1. **CI cleanup** (in progress): docs-only CI, unit on every OS, the nightly
   CHR channel sweep and the main-health gate landed in #631, and snapshot CHR
   reuse within a file in #612 PR 1. Left: #612 PR 2 (cross-file CHR reuse),
   designed for the nightly, and a hermetic integration tier (#654).
2. **Transport selection**, the first work on `0.2.0-next`. native-api becomes
   the default for `retrieve`, `api` and `execute`. Automatic selection falls
   back to the next available transport and reports each hop; a pinned `--via`
   still never falls back. Ports are stored per service, not as one `port=`.
   Issues: #588, #620, #621, #622, #131.
   [Protocol selection](CONSTITUTION.md#protocol-selection) changes in the
   same PR.
3. **[Devices and onboarding](#devices-and-onboarding).** Port discovery
   moves from `check` into `devices`, so an agent can add a device without
   reading `/ip/service` and storing ports by hand.

## Parked themes

Direction that is agreed but not scheduled. Each theme has four parts: the
question, the current lean, when it is ready, and the issues it absorbed.
Ready means eligible, not started: a ready theme waits until the maintainer
puts it on the current track. Absorbed issues are closed with the
`moved-to-docs` label: transferred history, not rejections. When a theme is
selected it moves to the current track, amends the constitution first where it
contradicts it, gets a section in its command or component README, and its
slices become new issues that link back to the absorbed ones. A theme entry
that keeps growing is being used as an issue.

### Workspace and local state

- **Question:** how centrs finds a project's own CDB and settings, and where
  data that spans CLI sessions lives.
- **Lean:** walk up from the working directory to a `.tikoci/` directory. Each
  tool owns a subdirectory: `.tikoci/centrs/` holds the CDB, `centrs.env` and
  `centrs.db`, apart from other tools' data, with owner-only permissions and
  its own `.gitignore`. The user-level directory uses the same layout. A
  workspace file may set only an allowlisted set of keys. The CDB is never
  synced to a remote; a push/pull scheme is a workspace tool's job.
- **Lean, `centrs.db`:** SQLite, derived, deletable and secret-free; no code
  path depends on it. First tables: `seen` facts from MNDP, ARP and ping. A
  session log records verb, target and error code only until redaction exists.
- **Ready when:** now. It adds a settings layer, so the constitution changes
  first.
- **Absorbed:** #92, #160.

### Devices and onboarding

- **Question:** one `devices` view of everything centrs can reach, and adding a
  device without hand-written port facts.
- **Lean:** `devices add` probes the services through the address it was given
  (one failure never stops the others; a device that only answers ping is
  recorded) and stores per-service ports. With no open port, ARP finds the MAC
  and MAC-Telnet is tried. `devices list` unions CDB records, quickchr machines,
  CMR members and twins (`twin=<quickchr-name>`). rosetta device data is opt-in
  (`devices show --specs`). `check` keeps the health battery and future rules.
- **Ready when:** transport selection is done; the current track already
  schedules it as step 3.
- **Absorbed:** #149, #173, #176, #441, #449, #585.

### CMR across surfaces

- **Question:** where CMR concepts appear in the CLI and MCP beyond
  `execute --cmr`, so an agent gets rich access to CMR features.
- **Lean:** the controller's own `/cmr/*` menus already read through
  `retrieve` and `api`; build on those first. `retrieve` stays the read-only
  route. Reading clients through `run-script` is considered only if CMR ships
  no other way, and the read-only rules still apply then. Every CMR build has
  `:serialize to=json`, so the older-version reason against serialize wrappers
  does not hold there. Members in `devices list` belong to Devices and
  onboarding, MCP access waits on delegated authorization (#449), and CMR setup
  (package, pairing, labels) is a Provisioning operation.
- **Ready when:** a consumer needs a CMR feature, or CMR leaves beta.
- **Absorbed:** none.

### Provisioning

- **Question:** several writes run as one validated operation: a user with an
  SSH key, device-mode, VLANs, pairing a CMR client.
- **Lean:** centrs owns the code. quickchr's post-boot steps (user and SSH
  key, packages, device-mode, license) are the first set, re-spun as generic
  operations: their logic is vendored, not their code, and quickchr stays as it
  is for CHR testing. Each operation is named and safe to re-run: it checks,
  plans, then applies. It is not a generic `update`, which the constitution
  still rules out, and version gates and the validation gate apply to every
  step.
- **Lean, hard parts first:** a step can depend on an earlier one (`/cmr`
  exists only after the package is installed and the router reboots), so the
  device cannot validate a whole operation up front; the likely rule is to gate
  each step just before it runs. Reboots reuse `retrieve --wait` readiness.
  RouterOS has no transaction across commands and a sent write is never
  retried, so recovery is re-running the operation. `--yes` and MCP's `confirm`
  cover the whole operation, not each step.
- **Lean, commands that never return:** some commands drop or hold the
  connection by design. `/system/device-mode/update` holds it until the change
  is confirmed by a reset or mode button press or a power cycle; RouterOS
  cancels the change if no confirmation arrives within its `activation-timeout`
  (5 minutes by default), and a regular reboot also cancels it.
  `/system/reboot`, `/system/package/update/install` and
  `/system/reset-configuration` drop it and restart. Today every transport
  reports them as `transport/timeout`, and an agent concludes the router is
  broken. A provisioning step that runs one expects the drop, confirms the
  router went down, then confirms it came back (`retrieve --wait`), instead of
  calling the drop a failure. `/system/shutdown` is terminal: its step ends
  once the router is confirmed down, and it never waits for a return. A lost
  response is still never treated as success on its own.
  `/system/routerboard/upgrade` does not reboot; unbounded `/ping` and
  `/tool/*` are a different case (no `count=` or `duration=`).
- **Ready when:** now. The step-validation rule is the first slice and amends
  the constitution.
- **Absorbed:** #363.

### Auth and secrets

- **Question:** unlocking an encrypted CDB without the password reaching a
  transcript, and per-device credentials that live outside the CDB.
- **Lean:** encrypted CDB by default, with a tip for unlocking from the user's
  environment. A password command or file read once per CDB load (#603),
  keychain and OAuth helpers, per-device auth overrides. A workspace file can
  never name a password command. Exports that carry secrets get a notice
  (#542). A host's secret prompt can alter what it passes on (T3 Code's
  `request_secret` trims whitespace,
  [upstream #31690](https://github.com/pingdotgg/t3code/issues/31690)), so docs never
  promise byte fidelity through one.
- **Ready when:** workspace and local state is done, because the workspace
  trust rule bounds the unlock channel.
- **Absorbed:** #420, #542, #603.

### Batch reads and sessions

- **Question:** a dashboard needs a dozen reads per refresh; how they share one
  login and one round trip.
- **Lean:** library first: one resolved, logged-in session (#401) and
  native-api tag multiplexing (#398), an array of retrieve requests in and an
  array of envelopes out. The CLI then gets attribute projection, `.query` and
  several reads per call as flags. No query language.
- **Ready when:** a library consumer needs it, or native-api becomes the
  default.
- **Absorbed:** #398, #401.

### Explain for agents

- **Question:** what `explain` shows by default to an agent on the research →
  explain → execute path.
- **Lean:** the default is the verdict, problems (error, warn, tip), a manual
  link and one tip, plus a nudge to run it live when it ran offline. Today's
  structure, tokens and evidence move behind `--syntax`. Parser internals move
  out of the command README into `components/offline-analysis/`. rosetta owns the documentation
  dataset (versioned files with a hash) and centrs fetches it. ANSI and HTML
  renderings, policy rules and secret detection build on this.
- **Ready when:** now. Manual links can ship first as a generated path → URL
  table.
- **Absorbed:** #90, #133, #223, #372, #373, #501, #507, #520, #573.

### Surface contracts

- **Question:** how the CLI, library, MCP and future web surfaces keep one
  shape, and where deliberate differences are tracked.
- **Lean:** generate the MCP tool reference the way `docs/CLI.md` is generated,
  and keep only deliberate divergences as structured data (TOML) beside each
  command's README; future web endpoints use the same tree. The first two argv
  words decide a command's risk class, so harness allowlists can match on
  prefixes. `execute` results become predictable (#360); catch-all error codes
  are split (#528). `--help` may carry one cheap line pointing to the skill or
  docs. MCP Apps (an interactive tool result rendered in the chat, a generic
  MCP extension) is a candidate rendering for tables and topology; T3 Code
  shows them for Codex only (tikoci/app-t3code#29).
- **Ready when:** now. #605's `isError` fix landed; its `structuredContent`,
  `outputSchema` and result-size budget are the next MCP slice.
- **Absorbed:** #95, #129, #148, #360, #528, #593, #606.

### Transfer methods

- **Question:** moving files where REST or native-api size limits, or missing
  SSH access, get in the way.
- **Lean:** `--via fetch` upload (centrs serves HTTP and the router runs
  `/tool/fetch`), File Share (`/ip/cloud/back-to-home-file`) where the router
  supports it, directory upload, a path from uploaded assets to an
  owner-accessible URL, and version-aware `mkdir`.
- **Ready when:** a consumer needs it; routeros-muse dashboards raised it
  first.
- **Absorbed:** #147, #548, #594, #595.

### CI, release and review

- **Question:** how much testing runs for each event, across platforms, without
  two full sweeps per change.
- **Lean:** versions and npm tags align across TIKOCI repos. Snapshot CHR
  reuse within a file landed in #612; cross-file reuse (#612 PR 2) is next and
  is designed for the nightly. Docs-only CI, cross-platform unit, the nightly
  sweep and the main-health gate landed (#631) and are described in
  `.github/instructions/ci-test-tiers-and-release-versioning.instructions.md`.
- **Ready when:** now; the current track schedules it as step 1.
- **Absorbed:** #97, #142.

### Docs and onboarding

- **Question:** how an agent or developer learns centrs without reading the
  source.
- **Lean:** the `routeros-tikoci-centrs` and `routeros-tikoci-quickchr-cli`
  skills are the agent entry point; they should name the command prefixes that
  are safe to allowlist. Pages publishes `llms.txt` and the generated CLI
  reference, the README shows real envelopes, and one worked example spans
  retrieve → export → transfer → `api --stream`. Many error pages are still
  scaffold stubs, tracked by a shrinking list in `error-pages.test.ts`; a tip
  carries a `detailsUrl` only when it has a page (#659).
  TIKOCI-wide instruction files are collected in `tikoci.github.io` and
  vendored here, each recording its source and revision.
- **Ready when:** now.
- **Absorbed:** #122, #140, #150, #151.

### RoMON and WinBox terminal

- **Question:** the `not-started` cells `execute / romon` and
  `execute / winbox-terminal`.
- **Lean:** both need reference tooling and typed failure mapping first, with
  protocol knowledge from `tikoci/m2ir`; MAC-Telnet stays the layer-2 path
  meanwhile. Their protocol specs go in `components/<protocol>/`, not the
  `terminal` or `execute` README.
- **Ready when:** they have reference tooling.
- **Absorbed:** none.

### SNMP and OIDs

- **Question:** how an agent setting up an NMS gets the OIDs for RouterOS
  properties, and whether centrs speaks SNMP at all.
- **Lean:** two parts. (a) OIDs over the API: `print` returns an `oid` for
  properties that SNMP exposes
  ([API manual → OID](https://manual.mikrotik.com/docs/developer-guides/api/#oid)),
  so `explain` or `retrieve` can show the property → OID map over rest-api or
  native-api, with no SNMP. (b) SNMP as a transport (MIB cache, community or v3
  credentials, new settings) waits for a consumer, and whether it becomes
  `retrieve --via snmp` is open. Until then `snmp` stays a known protocol id
  that fails as not implemented, and help and docs do not advertise it.
- **Lean, MIB cache:** a policy was signed off on 2026-06-06: XDG cache root,
  one directory per exact RouterOS version, never another version's MIB. Its
  full text left `commands/retrieve/README.md`; recover it with
  `git log -S "SNMP MIB cache policy" -- commands/retrieve/README.md`.
- **Ready when:** (a) now; (b) a consumer needs it.
- **Absorbed:** none.

## Nits

A nit is a small item written in one or two sentences. It is a candidate for
the next PR in its area, not required scope. Delete the line when the nit is
done or declined. A nit that needs more explanation is an issue.

- `execute`: a lone `print` sent through `execute` could get a tip that
  `retrieve` is the read-only verb a harness can allowlist. Agent sessions do
  this routinely (254 calls on one host), then read `.data.ret`, which is
  `null` for a print, whose rows are in `.data`.
- `execute`: `print proplist=` names are values, so both validation stages
  pass an unknown property (`/container/print proplist=status` then fails as
  `routeros/invalid-value`, tikoci/app-t3code#29). A
  `/console/inspect request=completion` check of the names would catch it.
- `btest` UDP: RouterOS's `tx-size` includes the 28-byte IP+UDP header (a
  1000 sends a 972-byte payload), while centrs sends the full size as payload;
  RouterOS's UDP client also fans out over 20 source ports
  (`connection-count=20`). Measured on CHR 7.25.1 and 7.24.6 in the #172
  retest.
- `execute --via ssh` sends a multi-line script as one prompt (CR line breaks,
  #576). An opt-in line-by-line mode (one prompt per line, as the console
  would run typed lines) could come later if a caller needs it.
- `.github/instructions/`: trim Copilot-era verbosity when the TIKOCI-wide
  files are collected in `tikoci.github.io`.
- `test/integration/api-stream-command.test.ts` fails intermittently in the
  unit tier: its fake server sends "Invalid RouterOS API length descriptor
  0xfb" (1 of 7 local runs, 2026-11-05).
