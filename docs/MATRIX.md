# Matrix

The product is a 2D grid of commands × protocols. This file is the **only**
source of truth for what is done. No alpha gates, no milestones, no roadmap
prose.

Pick the highest-priority cell that is not `CHR-passed`. That is the next
work. See `docs/CONSTITUTION.md` for the cell-state definitions.

## Cell states

| State          | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| `—`            | Not applicable / out of scope for this protocol                 |
| `not-started` | No code and no design                                           |
| `designed`     | `commands/<name>/README.md` describes intent and flags          |
| `coded`        | Implementation exists in `src/`                                 |
| `CHR-passed`   | Every example in `commands/<name>/examples.md` is green on CHR  |

A cell advances only with the matching evidence in the same change.

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
lives in `commands/<name>/examples.md` and the named integration tests. Keep this
section short enough that the grid remains the status surface.

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
- `explain` is `designed` (`commands/explain/README.md`): the explain →
  validate → run knowledge tier — canonical structure, LSP-like
  spans/diagnostics, transport classification (api-able vs execute, `curl`
  rendering), and live schema/completion facts. Its offline mode is the
  canonicalizer only, transport-less (evidence will be unit/fixture tests);
  the live probes (`/console/inspect` + `:parse`) ride rest-api/native-api,
  so those two cells are `designed`. The surface was decided in the
  2026-07-19 design round (#90) but the spec is **not ratified**: a
  canonicalization grounding pass (staging phase 0) gates ratification, and
  cells advance only after that plus green examples per the done rule.
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

Beyond the grid: post-`CHR-passed` hardening, ergonomics, and research work is
tracked in GitHub issues (`dry-july` and successors). Those issues may point back
to this matrix for current status, but they are not additional cell states.

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

The grid tracks the core (commands × protocols). Frontends are adapters over that
core and carry their own state, tracked here:

| Surface | State | Spec | Notes |
| ------- | ----- | ---- | ----- |
| ts-api | `CHR-passed` | `src/index.ts` | Root TypeScript library surface; everything else adapts it. |
| cli | `coded` | `src/cli/` | `retrieve`/`execute`/`transfer`/`terminal`/`devices`/`discover`/`btest` wired. |
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

## Priority order

Do not start a later item until the earlier cell or dependency checkpoint has
matching evidence. The grid above is the live status; per-item detail lives in
the linked `commands/<name>/`.

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
