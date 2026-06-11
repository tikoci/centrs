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
| stream   | —             | `designed`    | `designed`    | —             | —             | —             | —             | —                |
| execute  | `CHR-passed`  | `CHR-passed`  | `not-started` | `CHR-passed`  | —             | —             | `not-started` | `not-started`    |
| terminal | —             | —             | `not-started` | `not-started` | —             | —             | —             | —                |
| transfer | `coded`       | `coded`       | `designed`    | —             | —             | —             | —             | —                |
| devices  | —             | —             | —             | —             | —             | —             | —             | —                |
| discover | —             | —             | —             | —             | —             | `CHR-passed`  | —             | —                |
| check    | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started`    |
| config   | —             | —             | —             | —             | —             | —             | —             | —                |

`devices` does not use a transport in the protocol sense, so its grid row
stays `—`. Its cell state is `CHR-passed`: the read subset (`list`, `show`,
`groups`), the CDB mutation surface (`add`, `set`, `remove`; `edit` is reserved
for the future interactive editor and reports `usage/not-implemented`), `<router>`
lookup-key resolution (`identity`/`mac`/`ip`), the `(target, user)` record
identity, ambiguity / `--match` (`user=`/`target=`/record-type), the
`--profile-none`/`--profile-own` sentinels, the CLI verb aliases
(`print`/`get`/`rm`/`delete` → `list`/`show`/`remove`), and the
provenance/override examples are implemented in `src/devices.ts` and green under
`bun run test:integration`
against a CDB fixture built in-test from the known CDB primitives (open +
encrypted via `--cdb-password`). Every example in
`commands/devices/examples.md` is green via `bun run test:integration`
(`test/integration/devices.test.ts`); the command performs no network IO, so its
`CHR-passed` evidence is the fixture-backed integration run rather than a booted
CHR. Encrypted-CDB writes round-trip through the write layer's `encryptWith`
option using the password loaded from settings. Data sources (CDB, ARP cache,
MNDP cache, `dude.db` import) and their phasing live in
`commands/devices/README.md`.

The `__default__` fallback record is implemented at the resolver level
(`resolveCdb`/`resolveAuth`, unit-tested in `test/unit/resolver.test.ts`): a
device record's unset creds fall back per-field to `__default__`, and on the
CLI/API `__default__` supplies creds for an ad-hoc target with no record (MCP
keeps the allowlist). The top-level `tips[]` envelope channel is implemented too
(`Tip` in `src/core/envelope.ts`, always-present `[]`, rendered under a `Tips:`
footer in text mode); `devices` emits `tip/no-devices` and
`tip/credentials-missing` (example 40), and the CLI verb aliases
(`print`/`get`/`rm`/`delete`, example 41) resolve to their canonical verbs. The
whole decided `devices` redesign is now landed; the one remaining open item (ARP
test scheme) is tracked in `commands/devices/README.md`.

`discover` is `CHR-passed`: the MNDP wire codec (`src/data/mndp.ts`), the
TTL-expiring neighbor cache (`src/data/mndp-cache.ts`), the UDP listener, and
`discover --save` (which persists through `devices`' `addDevice` write layer)
live in `src/discover.ts`. The L2-dependent path — receiving and decoding a real
RouterOS MNDP announcement and saving it — is green against a real layer-2
segment via `bun run test:integration` (`test/integration/discover.test.ts`,
RouterOS CHR 7.23.1). That test boots a CHR with a second `socket-connect` NIC,
and a host shim (`test/integration/mndp-l2-bridge.ts`) lifts the UDP/5678 payload
out of QEMU's length-prefixed frame stream and re-delivers it to the **unmodified**
`listenMndp`→`parseMndpPacket`→cache→envelope path; the decoded `identity`,
`platform`, `board`, `version`, and `mac` are cross-checked against REST as the
source of truth, and `--save` writes a `macTarget`/`group=discovered`/`source=mndp`
record (examples 1, 2, 4). The remaining examples are network-independent CDB/bind
logic and stay green under `bun test`: the codec against crafted packet fixtures
(`test/unit/mndp.test.ts`), the TTL cache with an injected clock
(`test/unit/mndp-cache.test.ts`), and the listener / `--save` / port-in-use /
custom-group / de-dupe / encrypted-CDB paths over a loopback socket
(`test/unit/discover.test.ts`, examples 3, 5, 6, 7). A live integration finding:
MNDP's board TLV is the short board id (`CHR`) while REST `board-name` is the
verbose hardware string that begins with it. Flags, TTL/timeout defaults, the
`group=discovered` convention, and the L2 validation policy live in
`commands/discover/README.md`.

There is no `update` command: `execute` is the single read/write surface for
RouterOS add/set/remove, and `retrieve` stays read-only. See
`docs/CONSTITUTION.md` (protocol selection).

`stream` is `designed`: `commands/stream/README.md` describes the read-only
follow surface (RouterOS `print follow`/monitor/sniffer; `once`/`follow`/
`duration=`/`freeze-frame-interval=`), the NDJSON stream-of-envelopes contract,
and the native-api/ssh transport constraint (REST cannot follow — 60s cap). It
has no code yet; the native-api streaming reader it will consume already exists
(`src/protocols/native-api.ts`). Bounded single-shot reads stay on
`retrieve --once`; interactive PTY stays on `terminal`.

`transfer` is `coded` for `rest-api`/`native-api`: `src/transfer.ts` (verbs
`upload`/`download`/`list`/`remove`/`mkdir`/`copy`, size/direction-aware method
selection, leading-slash normalization, the `print`-probe existence guard, and
`--verify`/`--no-verify`) plus `src/cli/transfer.ts` (with the top-level
`upload`/`download` aliases). Every `/file` op rides the shared
`ProtocolAdapter` `execute`/`list` seam over both transports. Unit coverage is
`test/unit/transfer.test.ts` (path normalization, method-selection gating,
shape validation, and the REST round-trip wire shape via mocked `fetch`). The
cells carry small writes (`/file/set contents`, ≤60 KB) and all reads (chunked
`/file/read`). `test/integration/transfer.test.ts` is **green against a real CHR
7.23.1** (92 assertions): the rest + native round-trip, list + filters,
validate-before-write, device file management (mkdir/copy/remove), leading-slash
normalization, the >60 KB rejection, the error contract (missing file, bad creds,
conflicting flags), the native `N1`–`N4` mirror, and the `P1`–`P4` gating — which
confirmed the `/file` `get`/`set`/`add`/`copy`/`remove` wire shapes on real
RouterOS. They stay `coded` rather than `CHR-passed` only because the strict bar
is *every* example, and four are deliberately deferred as harness work: examples
8–10 (stdin/stdout/default-local, which need a non-console capture path) and
example 17 (the fetch-seeded >60 KB chunked read).

The single `ssh` grid column carries **two distinct methods** — `sftp` and `scp`
— which centrs treats separately even though they share the SSH transport.
**sftp is first**: it is the default secure method, and its `stat`/`readdir`/
partial ops are what make the existence check, `--verify`, and
`list`/`remove`/`mkdir` work over SSH (scp, a dumb byte-stream, can't). **scp is a
deliberate later pass** behind `--via scp` — kept because in some locked-down
environments it may be the only file path the SSH server exposes. Both are blocked
on the SSH transport landing as one unit via `terminal/ssh`; the column reads
`designed` for the sftp design, with scp tracked as the follow-on method.

`fetch` (centrs-as-HTTP-server + `/tool/fetch`) is a **deferred, explicit-only
method within the rest-api/native-api cells**, not a grid column — it needs
inbound reachability (router → centrs) so it is never auto-selected.

`config` is `designed` and transport-less (like `devices`), so its grid row
stays `—`. `commands/config/README.md` describes the `centrs.env` + `__default__`
front-end (interactive first-time setup plus `config get/set/reset/print`); no
code yet.

### Transport-base readiness (below the command grid)

The grid above tracks command cells (examples green for a `<command>` over a
`<protocol>`). Two transport bases are implemented and tested at the protocol
layer ahead of their command wiring, so the matching cells only need command
glue, not new protocol code:

- **native-api** (`src/protocols/native-api.ts`): word/sentence codec,
  streaming reader, login (post-6.43 plaintext + legacy MD5 challenge), tagged
  command multiplexing, and typed error mapping. Wired into `retrieve` behind
  `--via native-api` (see the `retrieve / native-api` cell, `CHR-passed`);
  `execute` over native-api still needs command wiring. Covered by
  `test/unit/native-api.test.ts`, `test/integration/native-api.test.ts`
  (transport), and `test/integration/native-api-retrieve.test.ts` (command),
  all green via `bun run test:integration`.
- **mac-telnet** (`src/protocols/mac-telnet.ts` + `mtwei.ts` +
  `mac-telnet-console.ts` + the `MacTelnetAdapter` in `adapter.ts`): packet/control
  codec, the session state machine, **both** auth methods (classic MD5 + MTWEI
  EC-SRP, `mtwei.ts`), an interactive-**console reader** (`mac-telnet-console.ts`:
  terminal-probe answering, license auto-clear, prompt sync, CR/LF screen
  emulation → clean per-command output, and a `:put [:parse]` validation gate),
  and a UDP datagram transport (`createUdpMacTelnetTransport`) wired into the
  execute orchestrator. **`execute / mac-telnet` is `CHR-passed`** end to end over
  real L2 against stock CHR 7.23.1: `executeEnvelope` (resolver →
  `MacTelnetAdapter` → UDP transport) runs reads, writes (REST-verified), and the
  validation-reject path, plus the console reader directly — all green via
  `bun run test:integration` (`test/integration/mac-telnet-console.test.ts`,
  examples 19–21). Transport/auth alone stay covered by
  `test/integration/mac-telnet.test.ts` (MTWEI login + MD5 refusal).
  **Caveat — what the CHR integration evidence does *not* cover:** it drives the
  session/console over the quickchr `socket-connect` **L2 bridge**
  (`test/integration/mactelnet-l2-bridge.ts`), so the real UDP transport
  (`createUdpMacTelnetTransport` and its egress/delivery choices) is *not*
  exercised there. That hid a real-device break — the in-packet source MAC was a
  synthetic `02:..`, which RouterOS silently ignores. **UDP-delivery facts (now
  real-device-verified against an RB1100AHx4 on RouterOS 7.24beta1 over a
  ZeroTier-extended LAN):** (a) the in-packet source MAC must be the **sending
  interface's real MAC** or the device never replies — `resolveEgressMac` reads it
  (with an `ifconfig`/sysfs fallback for virtual NICs that report all-zero); (b)
  the device answers only a **broadcast** delivery, not unicast; (c) macOS sends
  the limited `255.255.255.255` broadcast out the default-route NIC only, so
  reaching a device on another NIC (ZeroTier) needs that NIC's **directed**
  broadcast; (d) the reply is itself a broadcast, so the receiving socket must bind
  `0.0.0.0`. `MacTelnetAdapter` therefore runs `discoverMacTelnetRoute` for the
  default target — sprays every interface's directed broadcast with its real MAC,
  shared session key, first ACK wins — so `execute <mac>` finds the device on any
  NIC without naming an interface (the same reach WinBox's MAC connection has). Unit coverage:
  `test/unit/mtwei.test.ts` (EC-SRP math, byte-identical to `mtwei.c` / WinBox
  EC-SRP5), `test/unit/mac-telnet.test.ts` (handshake + MTWEI offer + auth-failure),
  and `test/unit/mac-telnet-console.test.ts` (screen emulation + output extraction
  pinned to real captured device bytes). **Grounded console findings (CHR 7.23.1):**
  (1) MTWEI is required — MD5 is offered but its proof is refused; (2) `END_AUTH` ≠
  success (a failed login sends `END_AUTH` then "Login failed" + `END`); (3) the
  console opens with a multi-step ANSI terminal-size probe — answering each `ESC[6n`
  (DSR) with `ESC[rows;colsR` sets a wide terminal (else it wraps at 80); (4) a
  ~10s terminal-negotiation stall on **every** login (answering the probe sets the
  width but does not remove it — a cursor-tracking emulator could); (5) a one-time
  first-login license prompt the reader auto-answers; (6) a successful console
  **write returns no output** (no `.id`); (7) the console `:parse` reports both
  `syntax error` and `bad parameter <name>`, so one gate covers syntax + the
  unknown-attribute (semantic) check — no `/console/inspect` table parsing.
  Reliability: `MacTelnetSession.tick` (driven by the console reader) does
  byte-counter retransmit on the reference backoff + an empty-ACK keepalive, and
  stray/malformed datagrams are dropped (not session-fatal). **Remaining:**
  `terminal / mac-telnet` (interactive PTY relay over the same console reader —
  stdin/stdout wiring + real PTY size; keepalive/retransmit already land via
  `tick`. See `commands/terminal/README.md`).

### Frontend surfaces (orthogonal to the command grid)

The grid tracks the core (commands × protocols). Frontends are adapters over that
core and carry their own state, tracked here:

| Surface | State | Spec | Notes |
| ------- | ----- | ---- | ----- |
| api (TS) | `CHR-passed` | `src/index.ts` | Root surface; everything else adapts it. |
| cli | `coded` | `src/cli/` | `retrieve`/`execute`/`devices`/`discover` wired. |
| mcp | `CHR-passed` | `commands/mcp/` | Scoped-verb stdio MCP server; CDB-as-allowlist safety model. Phase 1 (explain/validate/retrieve/execute, resources) plus first Phase 2 CDB mutation (`centrs_devices add`) green on CHR 7.23 via `test/integration/mcp.test.ts`, including gated write execution. |
| tui | `not-started` | `src/tui.ts` | Stub. |
| proxy | `not-started` | `src/webproxy.ts` | Stub. |

A surface advances to `CHR-passed` only when every example in its spec
(`commands/<surface>/examples.md`, where one exists) is green via
`bun run test:integration`. `mcp` is `CHR-passed` for Phase 1 plus the first
Phase 2 CDB mutation:
`commands/mcp/README.md` and `commands/mcp/examples.md` describe the tool surface,
safety model, and CHR test shape; examples 1-10 are green on CHR 7.23 via
`test/integration/mcp.test.ts`, including the `mcp=rw` + `confirm:true` RouterOS
write gate and `centrs_devices add` CDB registration.

### Peer measurement (`btest`) — orthogonal to the command grid

`btest` is the MikroTik **bandwidth test**, a peer measurement protocol (TCP/UDP
port 2000) — *not* a RouterOS-command transport — so it sits outside the
command×protocol grid above, like the transport-base and frontend-surface
sections. It is its own single protocol (`btest`, capability `measure` in
`src/protocols/index.ts`); `docs/CONSTITUTION.md` adds it as a deliberate
capability axis (peer measurement), exempt from the `:parse` / `/console/inspect`
gate. v1 scope (decided with the user): **both** client and server,
**EC-SRP5 + unauthenticated**, **TCP and UDP**; legacy pre-6.43 double-MD5 is out
of scope.

| Mode           | State         | Evidence target |
| -------------- | ------------- | --------------- |
| btest / server | `CHR-passed`  | CHR `/tool/bandwidth-test` client → centrs server (TCP+UDP, unauth + EC-SRP5) — CHR 7.23.1, `test/integration/btest.test.ts`. |
| btest / client | `coded`       | centrs client ↔ centrs server loopback + `btest.exe`-via-wine cross-check. |

Auth reuses the EC-SRP5 curve math shared with mac-telnet — now **extracted** into
`src/protocols/ec-srp5.ts` (mac-telnet stays byte-identical) with the net-new
**server** role (`ecSrp5ServerPublicKey`/`ecSrp5ServerShared`), loopback-tested.
The wire **codec** (`src/protocols/btest.ts`: command / `[len][payload]` EC-SRP5
4-message framing / status / UDP) is unit-tested. The **session state machine +
TCP/UDP data engines** (`src/protocols/btest-session.ts`), the **orchestrator**
(`src/btest.ts`: option-grammar validation, resolver-backed client, listener +
accept loop + max-sessions server, text/`--csv`/json-summary envelopes), and the
**CLI** (`centrs btest client|server`, `src/cli/btest.ts`) all exist and are
loopback-tested both roles (`test/unit/btest-session.test.ts`,
`test/unit/btest-command.test.ts`): the handshake (none + EC-SRP5), single-connection
TCP + UDP throughput, UDP loss accounting, and the option-grammar rejects — all
grounded on `manawenuz/btest-rs`. The **server** cell is `CHR-passed`: the gated
`test/integration/btest.test.ts` runs a real RouterOS `/tool/bandwidth-test` client
against the centrs server on **CHR 7.23.1** — TCP receive (server transmits) and
EC-SRP5 TCP receive (the net-new server verifier accepted by real RouterOS) and
UDP transmit (server receives, with loss accounting) all land sessions with
non-zero throughput. The **client** cell stays `coded` (loopback + transitive — no
direct client→CHR-server gate, by decision). TCP multi-connection
(`connection-count > 1`) data fan-out is a follow-up (the session token is
negotiated, but the server's parallel-stream join is not built).
Output: live `text` (default) or `--csv` streaming records, plus a single summary
envelope for `--format json`/`yaml` (`data.sessions[]` for the server,
`data.reports[]` for the client). The broader JSON-streaming (NDJSON) decision is
**deferred** — btest does not adopt the `stream` contract yet. See
`commands/btest/README.md` and `commands/btest/examples.md`.

**Honest grounding caveat (decided with the user):** the **server** mode gets
direct `CHR-passed` evidence — a real RouterOS `/tool/bandwidth-test` client dials
the centrs server over the QEMU SLIRP gateway `10.0.2.2` (no hostfwd; TCP any
direction + UDP **transmit**). UDP receive/both is a **soft smoke test** (logged,
not asserted): the server transmits fine, but guest *receipt* of server→guest UDP
through SLIRP NAT is unconfirmed (it needs the guest to originate the flow first) —
see `commands/btest/README.md`, Open questions.
The **client** mode is grounded **transitively**: the server test validates the
shared btest codec + EC-SRP5 against real RouterOS, and the loopback test proves
the client drives that codec. `btest.exe`-via-wine is a **coding-time grounding
aid** only (not CI, not the long-term plan). A **direct** centrs-client →
CHR-server gated test is **deferred future work** — it needs host→guest UDP/TCP
port mapping through QEMU, intentionally not set up now (a TCP-only version would
need only `hostfwd tcp:2000`).

## Priority order

Do not start a later item until the earlier cell or dependency checkpoint has
matching evidence.

1. **retrieve / rest-api** — `CHR-passed` against real CHR. This is the
   shakedown for everything else. See `commands/retrieve/examples.md`.
2. **CDB resolution and metadata overrides** — target → user/password from
   WinBox CDB, including the unused `--cdb-password` warning, comment-kv
   `via`/`port` overrides, and MAC resolution order (CDB, then ARP when opted
   in).
3. **CDB groups and fanout** — `--group`, multi-target de-dupe, concurrency,
   and outer/inner envelope shape must be grounded before execute starts.
4. **execute / native-api + rest-api** — CLI-shaped read/write surface
   (add/set/remove). Syntax gate via `:parse`, semantic validation via
   `/console/inspect` or server re-validation, structured path-POST (REST) /
   tagged `talk` (native). This is the single write path; there is no `update`.
5. **devices** — complete CDB mutation (`add`, `remove`, `set`, `edit`) and
   provenance.
6. **retrieve / snmp** — SNMP OID/MIB reads with MikroTik MIB download/cache
   (future).
7. **ssh** for execute/terminal/transfer — third transport, landing as one
   complete unit (not piecemeal), **introduced via `terminal/ssh`**. Settings
   names (`--ssh-key`/`CENTRS_SSH_KEY`/`ssh-key` comment-kv) are signed off; the
   `ssh-key` comment-kv allowlist entry arrives with the transport. See
   `commands/terminal/README.md` for the residual SSH unknowns.
8. **mac-telnet** for execute/terminal — L2 path, default execute route for
   unresolved MAC targets. `execute / mac-telnet` is **`CHR-passed`** (console
   reader + UDP transport + adapter; examples 19–21; byte-counter retransmit +
   empty-ACK keepalive via `MacTelnetSession.tick`). Remaining: `terminal /
   mac-telnet` (interactive PTY relay over the console reader) and the optional
   ~10s prime-latency fix (cursor-tracking DSR emulator).
9. **RoMON / WinBox Terminal for execute** — lower-priority execute surfaces
   after mac-telnet is grounded.
10. **discover / mndp** — `discover --save` populates CDB entries
    with provenance metadata and `group=discovered`.
11. **MCP, TUI, proxy** — frontends over the stable core. The MCP server is the
    near-term target (see `commands/mcp/`): a scoped-verb stdio server
    (`centrs_explain`, `centrs_validate`, `centrs_retrieve`, `centrs_execute`,
    then `centrs_devices`/`centrs_discover`) with the CDB as the device
    allowlist and per-device `mcp=ro|rw` write policy. Phase 1 ships stdio,
    explain/validate/retrieve/execute, device inspection, the `centrs://devices`
    / `centrs://errors` resources, and gated writes (CHR-tested,
    bench-consumable); Phase 2 has started with CDB mutations through
    `centrs_devices` (`add` CHR-tested; `edit`/`set`/`remove` unit-tested) and
    `centrs_discover` save gating (unit-tested). A
    device-free manifest dump (`centrs mcp --list-tools`, printing the registered
    schemas + `instructions` as JSON) is the next small step so the bench can
    measure centrs's always-on token footprint the way it counts mikrotik-mcp's
    166 schemas; examples 1–10 already carry stable IDs (`examples.md` ↔
    `test/integration/mcp.test.ts`) for per-trap citation.
    **HTTP access is the proxy surface's job, not the MCP server's** — MCP stays
    stdio-only. TUI/proxy remain later. These shape interface decisions today but
    do not block the command grid.
12. **btest (peer measurement)** — the bandwidth test as client + server, its own
    protocol axis (see "Peer measurement (`btest`)" above). Independent of the
    command grid: it shares only the EC-SRP5 curve math with mac-telnet (already
    `CHR-passed`), so it can proceed in parallel. v1: both modes, EC-SRP5 + unauth,
    TCP+UDP. Server mode reaches `CHR-passed` via a CHR bandwidth-test client;
    client mode is grounded transitively + against `btest.exe` (see the caveat
    above).

## Open questions (decisions needed before the affected cell can advance)

| Question | Affects cell | Notes |
| -------- | ------------ | ----- |
| RoMON / WinBox Terminal validation and CI | execute / romon, execute / winbox-terminal | Lower priority than mac-telnet; need reference tooling and typed failure mapping before advancing. |

Recently closed (folded into the specs): SNMP MIB-cache policy → `commands/retrieve/README.md`; bug-report rendering (inline `--bug-report` flag, no separate verb) → `docs/CONSTITUTION.md`; L2-in-CI for mac-telnet/MNDP (quickchr `socket-connect` host-side L2 capture; `socket-mcast` is macOS-broken) → `commands/discover/README.md` + `commands/execute/README.md`.

When a question is answered, fold the answer into the relevant
`commands/<name>/README.md` or `docs/CONSTITUTION.md`, then delete the row.
