# Matrix

This file owns **capability status and the selected work track**. The
command × protocol grid covers live operations; offline analysis, frontends,
and peer measurement have separate entries below. A capability's acceptance
criteria live in its `commands/<name>/README.md`; GitHub issues own the tasks
and dependencies that satisfy them.

Start with [Current priority](#current-priority), then the command's README,
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
| explain  | `designed`    | `designed`    | —             | —             | —             | —             | —             | —                |
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
- There is no `update` command. RouterOS CLI-shaped writes ride `execute`; the
  structured operation surface is `api`.
- `api --stream` absorbs the former `stream`/`tail` surface; native-api stream
  details are in `commands/api/README.md` and `src/protocols/native-api.ts`.
- `discover / mndp` is grounded by `commands/discover/README.md`,
  `src/data/mndp.ts`, `src/data/mndp-cache.ts`, and
  `test/integration/discover.test.ts`.
- `check` is `designed` (`commands/check/README.md`): a reach + health battery
  whose reads ride the execute-capable transports (rest-api/native-api/ssh/
  mac-telnet), so those four cells are `designed`; `snmp` and `romon`/
  `winbox-terminal` stay `not-started`. Its per-host fan-out is the machinery the
  IP-scan discovery (#149) will iterate; the L2-default timing evidence (#136) is
  recorded in the README before the cells advance past `designed`.
- `explain`'s two `designed` protocol cells are the future live probes
  (`/console/inspect` + `:parse`, #236). The live grammar
  (`explain <router> '<input>'`) is parsed and refused with
  `usage/not-implemented`, never degraded to an offline run. Offline analysis
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
| explain / offline baseline | `coded` | `commands/explain/README.md` → Offline baseline acceptance; offline examples in `test/unit/explain.test.ts`, focused `test/unit/explain-*` suites, and CHR captures under `test/fixtures/explain/`. The token partition is scored against device `highlight` by `test/unit/explain-highlight-agreement.test.ts` and `test/fixtures/explain/highlight-agreement.json`. The public entry is `@tikoci/centrs/explain`; its dependency boundary and executed browser-consumer proof are gated by `test/unit/explain-browser-entry.test.ts` (`bun run explain:browser-consumer`). | #90 indexes correctness, token agreement (#264/#263), and consumer verification. |

The CLI/library already expose structure, diagnostics, token partitions, symbols,
and flow-sensitive value facts. `coded` acknowledges that implementation while
the baseline still has open acceptance work; it is not a parser-coverage score.
Live probes (#236), MCP response alignment (#223), and future configuration
policies are distinct work, not prerequisites for using offline analysis.

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

## Current priority

**Offline `explain` baseline** is the selected track. Start with
[the #90 task index](https://github.com/tikoci/centrs/issues/90) and
[`commands/explain/README.md` → Offline baseline acceptance](../commands/explain/README.md#offline-baseline-acceptance).
The sequence is correctness and performance, token projection/agreement
(#264 B4 / #263), then a bounded browser/editor consumer check and the vocabulary
it needs (#264 B5). The projection and its device-agreement report have landed
(`bun run explain:highlight-agreement`); its `unprojected` residue is the
evidence B5 reads. The consumer boundary has landed too (#312): `@tikoci/centrs/explain`
is the documented entry, and `bun run explain:browser-consumer` gates both the
module graph and an executed browser bundle. What remains on the track is #322
(depth-axis growth) and #264 B5. The issue index owns the individual tasks and
their dependencies.

Unfinished SNMP, RoMON, TUI, or other protocol/frontend cells do not preempt this
track. Live `explain` (#236) remains a separate next capability. Change this
selection when the maintainer selects another track.

### Protocol backlog order

Retained for protocol work when selected; this is not a dependency chain for
offline analysis. Per-item detail lives in the linked `commands/<name>/`.

1. **retrieve / rest-api** — `CHR-passed` (`commands/retrieve/`).
2. **CDB resolution + metadata overrides** — `CHR-passed` (`commands/devices/`).
3. **CDB groups + fan-out** — `CHR-passed` (`commands/devices/`, fan-out core).
4. **execute / native-api + rest-api** — `CHR-passed` (`commands/execute/`).
5. **devices** (CDB mutation + provenance) — `CHR-passed` (`commands/devices/`).
6. **retrieve / snmp** — `not-started` (future: SNMP OID/MIB reads + MikroTik MIB cache).
7. **ssh** for transfer/execute/terminal — all three `CHR-passed`.
8. **mac-telnet** for execute/terminal — both `CHR-passed`.
9. **RoMON / WinBox Terminal for execute** — `not-started` (see Open questions).
10. **discover / mndp** — `CHR-passed` (`commands/discover/`).
11. **MCP, TUI, proxy** — MCP `CHR-passed`; TUI/proxy `not-started`.
12. **btest (peer measurement)** — server and client both `CHR-passed`.

## Open questions (decisions needed before the affected cell can advance)

| Question | Affects cell | Notes |
| -------- | ------------ | ----- |
| RoMON / WinBox Terminal validation and CI | execute / romon, execute / winbox-terminal | Lower priority than mac-telnet; need reference tooling and typed failure mapping before advancing. |

Recently closed (folded into the specs): SNMP MIB-cache policy → `commands/retrieve/README.md`; bug-report rendering (inline `--bug-report` flag, no separate verb) → `docs/CONSTITUTION.md`; L2-in-CI for mac-telnet/MNDP (quickchr `socket-connect` host-side L2 capture; `socket-mcast` is macOS-broken) → `commands/discover/README.md` + `commands/execute/README.md`.

When a question is answered, fold the answer into the relevant
`commands/<name>/README.md` or `docs/CONSTITUTION.md`, then delete the row.
