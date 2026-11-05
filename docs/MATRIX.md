# Matrix

This file owns **capability status, the current track, parked themes and
nits**. The command × protocol grid covers live operations; offline analysis,
frontends, and peer measurement have separate entries below. A capability's
acceptance criteria live in its `commands/<name>/README.md`; GitHub issues own
the actionable tasks that satisfy them.

Start with [Current track](#current-track), then the command's README,
examples, and linked issue. Verification follows `docs/CONSTITUTION.md` →
Done definition. A completed implementation slice is not proof that the whole
capability is complete.

## Cell states

| State          | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| `—`            | Not applicable / out of scope for this protocol                 |
| `not-started` | No code and no design                                           |
| `designed`     | `commands/<name>/README.md` describes intent and flags          |
| `coded`        | Implementation exists in `src/`                                 |
| `verified`     | Offline capability meets its command README's baseline acceptance criteria in full (examples, contract checks, measured/consumer gates, and CHR-grounded evidence). |
| `CHR-passed`   | Every example in `commands/<name>/examples.md` is green on CHR  |

A cell advances only with the matching evidence in the same change.

`verified` applies to offline capabilities; it does not advance a live protocol
cell. Existing `CHR-passed` fixture-backed `devices`/`settings` entries retain
their command-specific evidence contracts.

## Grid

| Command  | rest-api      | native-api    | ssh           | mac-telnet    | snmp          | mndp          | romon         | winbox-terminal |
| -------- | ------------- | ------------- | ------------- | ------------- | ------------- | ------------- | ------------- | ---------------- |
| retrieve | `CHR-passed`  | `CHR-passed`  | —             | —             | `not-started` | —             | —             | —                |
| api      | `CHR-passed`  | `CHR-passed`  | —             | —             | —             | —             | —             | —                |
| execute  | `CHR-passed`  | `CHR-passed`  | `CHR-passed`  | `CHR-passed`  | —             | —             | `not-started` | `not-started`    |
| terminal | —             | —             | `CHR-passed`  | `CHR-passed`  | —             | —             | —             | —                |
| transfer | `CHR-passed`  | `CHR-passed`  | `CHR-passed`  | —             | —             | —             | —             | —                |
| devices  | —             | —             | —             | —             | —             | —             | —             | —                |
| discover | —             | —             | —             | —             | —             | `CHR-passed`  | —             | —                |
| check    | `designed`    | `designed`    | `designed`    | `designed`    | `not-started` | `not-started` | `not-started` | `not-started`    |
| explain  | `CHR-passed`  | `CHR-passed`  | —             | —             | —             | —             | —             | —                |
| settings | —             | —             | —             | —             | —             | —             | —             | —                |

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
  its controller transports are the `execute` rest-api/native-api cells.
  CMR1–CMR7 and CMR10–CMR14 pass on a 7.26beta1 CHR lab over both, and
  CMR8–CMR9 over native-api (`test/integration/execute-cmr.test.ts`). CMR0 (a
  router without CMR) runs on the channel's CHR in `execute.test.ts`.
- There is no `update` command. RouterOS CLI-shaped writes ride `execute`; the
  structured operation surface is `api`.
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
  mac-telnet), so those four cells are `designed`; `snmp` and `romon`/
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
  has its own capability entry below. The generated structure tables
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
- Transport wire-format and delivery caveats belong in `src/protocols/*.ts`
  module headers. Do not expand this file with per-packet or per-router findings.

### Offline analysis

This capability opens no protocol connection. It is usable independently and
provides shared analysis for future integrations across the command grid.

| Capability | State | Contract and evidence | Work |
| ---------- | ----- | --------------------- | ---- |
| explain / offline baseline | `verified` | `commands/explain/README.md` → Offline baseline acceptance; offline examples in `test/unit/explain.test.ts`, focused `test/unit/explain-*` suites, and CHR captures under `test/fixtures/explain/`. The token partition is scored against device `highlight` by `test/unit/explain-highlight-agreement.test.ts` and `test/fixtures/explain/highlight-agreement.json`. The public entry is `@tikoci/centrs/explain`; its dependency boundary and executed browser-consumer proof are gated by `test/unit/explain-browser-entry.test.ts` (`bun run explain:browser-consumer`). #322's fixed-size 16× depth guard and deterministic structural-work guards close the bounded-execution criterion. | Closed history: #90 (correctness, token agreement #264/#263, consumer verification, bounded execution #322). Follow-on work: [Explain for agents](#explain-for-agents). |

The CLI/library expose structure, diagnostics, token partitions, symbols, and
flow-sensitive value facts. `verified` records the offline acceptance evidence;
it is not a parser-coverage score and does not advance either live protocol cell.
Live probes (#236), MCP response alignment and future configuration policies
([Explain for agents](#explain-for-agents)) are distinct work, not
prerequisites for using offline analysis.

### Transport-base readiness

The grid above tracks command cells. The transports those cells ride are
implemented and grounded in their `src/protocols/*.ts` **module headers** — the
single home for wire-format, auth, and delivery facts.

| Transport | Status pointer |
| --------- | -------------- |
| native-api | Used by `retrieve`, `api`, `execute`, and `transfer`; wire facts in `src/protocols/native-api.ts`. |
| ssh / sftp | Used by `transfer`, `execute`, and `terminal`; facts in `src/protocols/ssh.ts`, `src/protocols/sftp.ts`, and `src/terminal.ts`. |
| mac-telnet | Used by `execute` and `terminal`; facts in `src/protocols/mac-telnet.ts`, `src/protocols/mac-telnet-console.ts`, `src/protocols/mtwei.ts`, and `src/protocols/adapter.ts`. |

### Frontend surfaces (orthogonal to the command grid)

Frontends adapt the shared analysis and device-operation core and carry their
own state, tracked here:

| Surface | State | Spec | Notes |
| ------- | ----- | ---- | ----- |
| ts-api | `CHR-passed` | `src/index.ts` | Root TypeScript library surface; everything else adapts it. |
| cli | `coded` | `src/cli/` | Every command in `cliCommands` (`src/cli.ts`) is wired: `retrieve`/`execute`/`api`/`transfer`/`terminal`/`explain`/`devices`/`discover`/`btest`/`mcp`/`settings`, plus the `upload`/`download` shortcuts. |
| mcp | `CHR-passed` | `commands/mcp/` | Scoped-verb stdio MCP server; details in `commands/mcp/README.md` and `test/integration/mcp.test.ts`. |
| tui | `not-started` | `src/tui.ts` | Stub. |
| proxy | `not-started` | `src/webproxy.ts` | Stub. |

A surface advances to `CHR-passed` only when every example in its spec
(`commands/<surface>/examples.md`, where one exists) is green via
`bun run test:integration`. The `mcp` surface's tool list, CDB-as-allowlist safety
model, and CHR test shape (examples 1–10, the `mcp=rw` + `confirm:true` write gate)
are documented in `commands/mcp/README.md` and `commands/mcp/examples.md`.

### Peer measurement (`btest`) — orthogonal to the command grid

`btest` is the MikroTik bandwidth test (peer measurement, TCP/UDP port 2000),
not a RouterOS-command transport. It sits outside the command×protocol grid as
its own capability axis and is exempt from the RouterOS command-validation gate.

| Mode           | State        | Evidence |
| -------------- | ------------ | -------- |
| btest / server | `CHR-passed` | `test/integration/btest.test.ts`; details in `commands/btest/README.md`. |
| btest / client | `CHR-passed` | `test/integration/btest-client.test.ts`; details in `commands/btest/README.md`. |

Wire, auth, TCP/UDP, and CI caveats live in `commands/btest/README.md` and the
`src/protocols/btest*.ts` / `src/protocols/ec-srp5.ts` module headers.

## Current track

The maintainer sets this list. Open bugs are worked alongside it without being
selected. Unfinished grid cells and parked themes do not preempt it.

1. **Release 0.1.10** (in progress).
2. **Transport selection**, the first work on `0.2.0-next`. native-api becomes
   the default for `retrieve`, `api` and `execute`. Automatic selection falls
   back to the next available transport and reports each hop; a pinned `--via`
   still never falls back. Ports are stored per service, not as one `port=`.
   Issues: #588, #620, #621, #622, #131.
   [Protocol selection](CONSTITUTION.md#protocol-selection) changes in the
   same PR.
3. **Next: [Devices and onboarding](#devices-and-onboarding).** Port discovery
   moves from `check` into `devices`, so an agent can add a device without
   reading `/ip/service` and storing ports by hand.

## Parked themes

Direction that is agreed but not scheduled. Each theme has four parts: the
question, the current lean, what starts it, and the issues it absorbed.
Absorbed issues are closed with the `moved-to-docs` label: transferred history,
not rejections. When a theme is selected it moves to the current track, amends
the constitution first where it contradicts it, gets a section in its command
README, and its slices become new issues that link back to the absorbed ones.
A theme entry that keeps growing is being used as an issue.

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
- **Starts when:** the maintainer selects it. It adds a settings layer, so the
  constitution changes first.
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
- **Starts when:** transport selection is done (current track, step 3).
- **Absorbed:** #149, #173, #176, #441, #449, #585.

### Auth and secrets

- **Question:** unlocking an encrypted CDB without the password reaching a
  transcript, and per-device credentials that live outside the CDB.
- **Lean:** encrypted CDB by default, with a tip for unlocking from the user's
  environment. A password command or file read once per CDB load (#603),
  keychain and OAuth helpers, per-device auth overrides. A workspace file can
  never name a password command. Exports that carry secrets get a notice
  (#542).
- **Starts when:** workspace and local state is done, because the workspace
  trust rule bounds the unlock channel.
- **Absorbed:** #420, #542, #603.

### Batch reads and sessions

- **Question:** a dashboard needs a dozen reads per refresh; how they share one
  login and one round trip.
- **Lean:** library first: one resolved, logged-in session (#401) and
  native-api tag multiplexing (#398), an array of retrieve requests in and an
  array of envelopes out. The CLI then gets attribute projection, `.query` and
  several reads per call as flags. No query language.
- **Starts when:** a library consumer needs it, or native-api becomes the
  default.
- **Absorbed:** #398, #401.

### Explain for agents

- **Question:** what `explain` shows by default to an agent on the research →
  explain → execute path.
- **Lean:** the default is the verdict, problems (error, warn, tip), a manual
  link and one tip, plus a nudge to run it live when it ran offline. Today's
  structure, tokens and evidence move behind `--syntax`. Parser internals move
  out of the command README into their own file. rosetta owns the documentation
  dataset (versioned files with a hash) and centrs fetches it. ANSI and HTML
  renderings, policy rules and secret detection build on this.
- **Starts when:** the maintainer selects it. Manual links can ship first as a
  generated path → URL table.
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
  docs.
- **Starts when:** the maintainer selects it. MCP work starts from #605's
  `isError` fix.
- **Absorbed:** #95, #129, #148, #360, #528, #593, #606.

### Transfer methods

- **Question:** moving files where REST or native-api size limits, or missing
  SSH access, get in the way.
- **Lean:** `--via fetch` upload (centrs serves HTTP and the router runs
  `/tool/fetch`), File Share (`/ip/cloud/back-to-home-file`) where the router
  supports it, directory upload, a path from uploaded assets to an
  owner-accessible URL, and version-aware `mkdir`.
- **Starts when:** a consumer needs it; routeros-muse dashboards raised it
  first.
- **Absorbed:** #147, #548, #594, #595.

### CI, release and review

- **Question:** how much testing runs for each event, across platforms, without
  two full sweeps per change.
- **Lean:** unit tests on every platform for every code push and PR; docs-only
  changes run lint only. The CHR sweep runs nightly when main or a RouterOS
  channel version changed, and at release. A PR cannot merge while the last
  nightly is red. Versions and npm tags align across TIKOCI repos. Snapshot CHR
  reuse is piloted in #612.
- **Starts when:** path gating and the nightly are next; the rest when the
  maintainer selects it.
- **Absorbed:** #97, #142.

### Docs and onboarding

- **Question:** how an agent or developer learns centrs without reading the
  source.
- **Lean:** the `routeros-centrs` and `routeros-quickchr-cli` skills are the
  agent entry point; they should name the command prefixes that are safe to
  allowlist. Pages publishes `llms.txt` and the generated CLI reference, the
  README shows real envelopes, and one worked example spans retrieve → export →
  transfer → `api --stream`. TIKOCI-wide instruction files are collected in
  `tikoci.github.io` and vendored here.
- **Starts when:** the maintainer selects it.
- **Absorbed:** #122, #140, #150, #151.

### RoMON, WinBox terminal and SNMP

- **Question:** the `not-started` cells `execute / romon`,
  `execute / winbox-terminal` and `retrieve / snmp`.
- **Lean:** RoMON and WinBox terminal need reference tooling and typed failure
  mapping first, with protocol knowledge from `tikoci/m2ir`; MAC-Telnet stays
  the layer-2 path meanwhile. SNMP reads come with the MIB cache described in
  `commands/retrieve/README.md`.
- **Starts when:** the maintainer selects it.
- **Absorbed:** none.

## Nits

A nit is one or two sentences about something small. It rides the next PR that
touches its area, and that PR deletes the line. Anything longer is an issue.

- `execute`: a lone `print` sent through `execute` could get a tip that
  `retrieve` is the read-only verb a harness can allowlist.
- `.github/instructions/`: trim Copilot-era verbosity when the TIKOCI-wide
  files are collected in `tikoci.github.io`.
