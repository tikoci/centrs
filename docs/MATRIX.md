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
| check    | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started`    |
| settings | —             | —             | —             | —             | —             | —             | —             | —                |

`devices` does not use a transport in the protocol sense, so its grid row stays
`—`; its cell state is `CHR-passed`. `devices` performs no network IO, so that
evidence is a fixture-backed `bun run test:integration` run
(`test/integration/devices.test.ts`, every example in
`commands/devices/examples.md`) against an in-test CDB (open + encrypted), not a
booted CHR. The implemented surface (read subset, CDB mutation, lookup-key
resolution, `(target, user)` identity, ambiguity / `--match`, profile sentinels,
verb aliases, `__default__`, `tips[]`, provenance/override) and the one open item
(ARP test scheme) are documented in `commands/devices/README.md`.

`discover` is `CHR-passed`: the MNDP codec (`src/data/mndp.ts`), the TTL neighbor
cache (`src/data/mndp-cache.ts`), the UDP listener, and `discover --save`
(through `devices`' atomic write layer) live in `src/discover.ts`. The real-L2
receive/decode/save path is green on RouterOS CHR 7.23.1 via
`test/integration/discover.test.ts` (the quickchr `socket-connect` L2 bridge,
`test/integration/mndp-l2-bridge.ts`; examples 1, 2, 4); the network-independent
codec/cache/listener/`--save` paths stay unit-tested (examples 3, 5, 6, 7). The
wire format, the de-dupe rule (`target`-keyed today, MAC-keyed is the decided
target), TTL/timeout defaults, the live board-TLV finding (short board id vs the
verbose REST `board-name`), and the L2 validation policy are documented in
`commands/discover/README.md`.

There is no `update` command: `execute` is the single read/write surface for
RouterOS *CLI-shaped* add/set/remove, and `retrieve` stays read-only. The `api`
command is the structured one-command-per-operation surface (the verb trichotomy
in `commands/api/README.md`); it can also write. See `docs/CONSTITUTION.md`
(protocol selection).

`api` is `CHR-passed` for `rest-api` and `native-api`: endpoint normalization, the
method→verb map, the `/console/inspect` gate, write confirmation, `.query`/
`.proplist`, `-f`/`-d`/`--input` bodies, `--raw`, `/execute` script-run
(`=as-string=` for sync output on both transports), **multi-target fan-out**
(`--group`/`--where`/`--all`/`--default`/positionals over the shared
`src/resolver/selection.ts` grammar + `src/core/fanout.ts` engine: locked
`FanoutData` envelope, granular `0/2/1` exit code, `--yes`-once write confirm with
a blast-radius message, `--listen`/`--raw` fan-out guards), **and** open-ended
`--stream` follow (native-api only — `NativeApiSession.listen()` + `/cancel`,
NDJSON envelope frames with a terminating summary; `--via rest-api --stream`
errors `transport/capability-unsupported`; single-session, so N>1 targets →
`usage/fanout-not-supported`). Green on CHR 7.23.1 via
`test/integration/api.test.ts` + `api-native.test.ts` + `api-fanout.test.ts` (F1–F9:
group, `--where`, empty, write-reject, write, `--all`, positional+group union,
`--concurrency`, `--default` guard) + `api-listen.test.ts` and the `cli-smoke`
guards. No remaining deferrals for `api`.

`api` **absorbs** the former `stream` command (folded — no separate row): the
read-only follow surface is `api <router> <endpoint> --stream` (alias `--listen`;
the `/listen` endpoint form infers it), native-api only, since REST's 60s cap
cannot follow. `centrs stream`/`centrs tail` now error with a pointer to
`api --stream`.

`transfer` is `CHR-passed` for `rest-api`/`native-api` and for **sftp** (the
`ssh` column's first method): `src/transfer.ts` + `src/cli/transfer.ts`
(size/direction-aware method selection, leading-slash normalization, the
`print`-probe existence guard, `--verify`) over the shared `FileBackend` seam,
with the SFTP client in `src/protocols/sftp.ts` (host OpenSSH `sftp` subsystem;
`scp` deferred). `test/integration/transfer.test.ts` is green on real CHR 7.23.1
(110 assertions): the rest + native round-trip, the native `N1`–`N4` mirror, the
sftp `S1`–`S5` round-trip, the stdin/stdout forms via the subprocess harness
(examples 8–10), and example 17 (chunked REST read of an sftp-seeded >60 KB file).
The method-selection grammar, the SFTP-vs-SCP rationale, the `--verify` behavior
(sftp trusts the transfer guarantee; rest/native re-read the `/file` size), and the
deferred `scp`/`fetch`/`ftp` methods are documented in
`commands/transfer/README.md`.

`execute / ssh` is `CHR-passed` (the second SSH consumer): a per-command batch
client (`SshExecClient` in `src/protocols/ssh.ts` — one `ssh user@host "<cmd>"`
per command, sharing `sftp.ts`'s host-`ssh` plumbing) behind the `SshExecAdapter`
console transport (execute-only, like mac-telnet; structured reads/inspect
unsupported). It reuses the mac-telnet `:put [:parse …]` gate verbatim. Green via
`test/integration/execute-ssh.test.ts` (S1–S4) + `test/unit/ssh.test.ts`; the
no-PTY / clean-output / `:parse` wire grounding lives in the `src/protocols/ssh.ts`
header and `commands/execute/README.md`.

`terminal / ssh` is `CHR-passed` (the third and last SSH consumer): it execs the
host `ssh` with inherited stdio (`buildSshTerminalArgv` in `src/terminal.ts`,
reusing `sshCommonOptions`) and lets the OS relay RouterOS's already-clean no-PTY
console — no screen emulation. No `-t` is passed (`-tt` hangs RouterOS);
`runTerminal` returns `ssh`'s exit code. A host target defaults to ssh, a MAC
target to mac-telnet. Green via `test/integration/terminal-ssh.test.ts` (TS1/TS2),
with argv unit-tested in `test/unit/terminal.test.ts`. **All three SSH cells
(transfer/execute/terminal) are `CHR-passed`.** The no-PTY / exit-code semantics are documented in
`src/terminal.ts`; the no-multi-line-brace limitation is in
`commands/terminal/README.md`.

`fetch` (centrs-as-HTTP-server + `/tool/fetch`) is a **deferred, explicit-only
method within the rest-api/native-api cells**, not a grid column — it needs
inbound reachability (router → centrs) so it is never auto-selected.

`settings` is `designed` and transport-less (like `devices`), so its grid row
stays `—`. `commands/settings/README.md` describes the `centrs.env` + `__default__`
front-end (interactive first-time setup plus `settings get/set/reset/print`); no
code yet.

### Transport-base readiness (below the command grid)

The grid above tracks command cells. The transports those cells ride are
implemented and grounded in their `src/protocols/*.ts` **module headers** — the
single home for wire-format, auth, and delivery facts (one fact, one place).
Status here is terse; the module header carries the detail.

- **native-api** (`src/protocols/native-api.ts`): word/sentence codec, streaming
  reader, login (post-6.43 plaintext + legacy MD5 challenge), tagged command
  multiplexing, typed error mapping. Live cell status is in the grid (`retrieve`,
  `execute`, and `transfer` over `native-api` are all `CHR-passed`). Covered by
  `test/unit/native-api.test.ts`, `test/integration/native-api.test.ts`
  (transport), and `test/integration/native-api-retrieve.test.ts` (command).
- **mac-telnet** (`src/protocols/mac-telnet.ts` + `mtwei.ts` +
  `mac-telnet-console.ts` + `MacTelnetAdapter` in `adapter.ts`): packet/control
  codec, session state machine, both auth methods (classic MD5 + MTWEI EC-SRP),
  the interactive-console reader, and the UDP datagram transport with route
  discovery. The deep findings — auth (MTWEI-required / MD5-refused /
  `END_AUTH`≠success), console (ANSI terminal-size probe, ~10s prime stall,
  one-time license gate, `:put [:parse]` syntax+semantic gate, silent writes),
  reliability (byte-counter retransmit + empty-ACK keepalive), and the
  real-device UDP-delivery facts (real egress MAC required; broadcast-only reply;
  per-NIC directed-broadcast reach via `discoverMacTelnetRoute`; bind `0.0.0.0`)
  — are documented in those module headers. Two cells are `CHR-passed`:
  - **`execute / mac-telnet`**: `executeEnvelope` (resolver → `MacTelnetAdapter` →
    UDP transport) runs reads, REST-verified writes, and the validation-reject
    path. Green via `test/integration/mac-telnet-console.test.ts` (examples
    19–21); transport/auth alone via `test/integration/mac-telnet.test.ts` (MTWEI
    login + MD5 refusal). Unit: `test/unit/{mtwei,mac-telnet,mac-telnet-console}.test.ts`.
  - **`terminal / mac-telnet`**: the interactive relay over the same console
    reader (`MacTelnetConsole.attachInteractive`), orchestrated in
    `src/terminal.ts` over an injectable `TerminalIo`, reusing the execute
    resolver and the shared `resolveMacTelnetRoute`. Green via
    `test/integration/terminal-mac-telnet.test.ts` (T1–T3) driving the real
    `centrs terminal` binary through the subprocess harness.
  - **Evidence caveat:** the CHR integration runs over the quickchr
    `socket-connect` **L2 bridge** (`test/integration/mactelnet-l2-bridge.ts`), so
    the real `createUdpMacTelnetTransport` egress/broadcast path is *not* exercised
    in CI — the RB1100AHx4 / RouterOS 7.24beta1 real-device run grounded the
    UDP-delivery facts (and caught the synthetic-source-MAC break). A full-TTY
    `terminal` test (real PTY via `script(1)`/node-pty) is likewise deferred.

### Frontend surfaces (orthogonal to the command grid)

The grid tracks the core (commands × protocols). Frontends are adapters over that
core and carry their own state, tracked here:

| Surface | State | Spec | Notes |
| ------- | ----- | ---- | ----- |
| ts-api | `CHR-passed` | `src/index.ts` | Root **TypeScript library** surface; everything else adapts it. (Renamed from `api (TS)` to avoid colliding with the `api` **command** row in the grid above — the command is a verb, this is the library.) |
| cli | `coded` | `src/cli/` | `retrieve`/`execute`/`transfer`/`terminal`/`devices`/`discover`/`btest` wired. |
| mcp | `CHR-passed` | `commands/mcp/` | Scoped-verb stdio MCP server; CDB-as-allowlist safety model. Phase 1 (explain/validate/retrieve/execute, resources) plus first Phase 2 CDB mutation (`centrs_devices add`) green on CHR 7.23 via `test/integration/mcp.test.ts`, including gated write execution. |
| tui | `not-started` | `src/tui.ts` | Stub. |
| proxy | `not-started` | `src/webproxy.ts` | Stub. |

A surface advances to `CHR-passed` only when every example in its spec
(`commands/<surface>/examples.md`, where one exists) is green via
`bun run test:integration`. The `mcp` surface's tool list, CDB-as-allowlist safety
model, and CHR test shape (examples 1–10, the `mcp=rw` + `confirm:true` write gate)
are documented in `commands/mcp/README.md` and `commands/mcp/examples.md`.

### Peer measurement (`btest`) — orthogonal to the command grid

`btest` is the MikroTik **bandwidth test** (peer measurement, TCP/UDP port 2000)
— *not* a RouterOS-command transport, so it sits outside the command×protocol
grid as its own capability axis (`measure` in `src/protocols/index.ts`), exempt
from the `:parse` / `/console/inspect` gate. v1 scope (decided with the user):
**both** client and server, **EC-SRP5 + unauthenticated**, **TCP and UDP** (legacy
pre-6.43 double-MD5 is out of scope).

| Mode           | State        | Evidence |
| -------------- | ------------ | -------- |
| btest / server | `CHR-passed` | CHR `/tool/bandwidth-test` client → centrs server (TCP+UDP, unauth + EC-SRP5), CHR 7.23.1, `test/integration/btest.test.ts`. |
| btest / client | `CHR-passed` | centrs client → CHR `/tool/bandwidth-server` over a host→guest `tcp:2000` forward — unauth + **EC-SRP5 client proof verified by real RouterOS** + wrong-pass reject (TCP receive), CHR 7.23.1, `test/integration/btest-client.test.ts`; plus client↔server loopback (`test/unit/btest-*.test.ts`). |

The wire codec, the EC-SRP5 session/handshake (shared core byte-identical with
mac-telnet's MTWEI, plus the net-new server role), the TCP/UDP data engines, the
orchestrator + CLI, and the honest grounding caveat (the server gets direct CHR
evidence over the QEMU SLIRP gateway `10.0.2.2`; the client gets direct CHR
evidence over a host→guest `tcp:2000` forward (the forward carries TCP; UDP rides
the guest→host gateway instead, below); UDP-receive was
previously a soft smoke test because the SLIRP reverse path was believed to block
real validation and a `connect()` socket filter was silently dropping all received
datagrams — RouterOS sends UDP data **from a different source port** than the
negotiated `serverUdpPort`, so the BSD receive filter rejected every packet;
fixed by removing `connect()` and addressing sends explicitly, validated against
a real RouterOS device at 163–203 Mbps receive and 104 Mbps bidirectional, and
**CI now gates UDP client receive/both** — the server→client return rides the
guest→host SLIRP gateway (`10.0.2.2:clientUdpPort`), needing no UDP forward and no
quickchr change (#88 closed; the `connect()` filter fix in #86 is what enabled it);
TCP
`connection-count` reaches the server's command packet (#84) and centrs opens the
negotiated extra TCP data connections — multi-connection **fan-out** (#87),
grounded byte-for-byte against RouterOS 7.23.1 (secondary join
`[token:u16 BE][0x02][0 …]`) and CHR-gated for the realized fan-out
(`activeConnections == count`; no throughput-rise assertion — the SLIRP loopback is
bandwidth-bound); authenticated sessions stay single-stream (warned); TCP
`direction=both` demuxes the server's
interleaved status frames so the client paces its TX from feedback and does not
starve server→client RX (#85 fixed); the Windows unit tier skips UDP-loopback
tests (#69); NDJSON is not adopted) are
documented in `commands/btest/README.md` and the `src/protocols/btest.ts`,
`src/protocols/btest-session.ts`, and `src/protocols/ec-srp5.ts` module headers.

## Priority order

Do not start a later item until the earlier cell or dependency checkpoint has
matching evidence. The grid above is the live status; per-item detail lives in
the linked `commands/<name>/`.

1. **retrieve / rest-api** — `CHR-passed`. The shakedown for everything else (`commands/retrieve/`).
2. **CDB resolution + metadata overrides** — `CHR-passed` (`commands/devices/`).
3. **CDB groups + fanout** — `CHR-passed` (`commands/devices/`, Fanout).
4. **execute / native-api + rest-api** — `CHR-passed` (`commands/execute/`). The single write path; there is no `update`.
5. **devices** (CDB mutation + provenance) — `CHR-passed` (`commands/devices/`).
6. **retrieve / snmp** — `not-started` (future: SNMP OID/MIB reads + MikroTik MIB cache).
7. **ssh** for transfer/execute/terminal — **all three `CHR-passed`** (landed transfer-first; the `transfer`/`execute`/`terminal` READMEs + `src/protocols/ssh.ts` and `src/protocols/sftp.ts`).
8. **mac-telnet** for execute/terminal — both `CHR-passed` (`src/protocols/mac-telnet.ts` + `src/protocols/mac-telnet-console.ts`). Optional polish: the ~10s prime-latency fix and a full-TTY terminal test under a real PTY.
9. **RoMON / WinBox Terminal for execute** — `not-started` (see Open questions).
10. **discover / mndp** — `CHR-passed` (`commands/discover/`).
11. **MCP, TUI, proxy** — frontends over the stable core. **MCP** is `CHR-passed` for Phase 1 + the first Phase 2 CDB mutation (`commands/mcp/`); next small step is the device-free `centrs mcp --list-tools` manifest dump (bench token-footprint measurement). MCP stays **stdio-only** (HTTP is the proxy's job). **TUI / proxy** `not-started`.
12. **btest (peer measurement)** — server **and** client both `CHR-passed` (`commands/btest/`). Own protocol axis; shares EC-SRP5 with mac-telnet, so it can proceed in parallel.

## Open questions (decisions needed before the affected cell can advance)

| Question | Affects cell | Notes |
| -------- | ------------ | ----- |
| RoMON / WinBox Terminal validation and CI | execute / romon, execute / winbox-terminal | Lower priority than mac-telnet; need reference tooling and typed failure mapping before advancing. |

Recently closed (folded into the specs): SNMP MIB-cache policy → `commands/retrieve/README.md`; bug-report rendering (inline `--bug-report` flag, no separate verb) → `docs/CONSTITUTION.md`; L2-in-CI for mac-telnet/MNDP (quickchr `socket-connect` host-side L2 capture; `socket-mcast` is macOS-broken) → `commands/discover/README.md` + `commands/execute/README.md`.

When a question is answered, fold the answer into the relevant
`commands/<name>/README.md` or `docs/CONSTITUTION.md`, then delete the row.
