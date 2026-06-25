# btest

Run MikroTik's **bandwidth test** as a cross-platform client or server. `btest`
is centrs's peer-measurement surface: it mirrors `/tool/bandwidth-test` (client)
and `/tool/bandwidth-server` (server), so it is a drop-in for the Windows-only
`btest.exe` on macOS/Linux.

Status: server **and** client both `CHR-passed`. The protocol **codec**
(`src/protocols/btest.ts`), the shared **EC-SRP5** core including the net-new
server role (`src/protocols/ec-srp5.ts`), the **session state machine + TCP/UDP
data engines** (`src/protocols/btest-session.ts`), the **orchestrator**
(`src/btest.ts`), and the **CLI** (`centrs btest client|server`) all exist and are
unit/loopback-tested. Two gated CHR integration tests **pass on CHR 7.23.1**:
`test/integration/btest.test.ts` lands a real RouterOS `/tool/bandwidth-test`
client's TCP-receive, UDP-transmit (with loss accounting), and **EC-SRP5** sessions
on the centrs **server**; `test/integration/btest-client.test.ts` runs the centrs
**client** against a real RouterOS `/tool/bandwidth-server` over a host→guest
`tcp:2000` forward — unauthenticated TCP receive, an **EC-SRP5 client proof
verified by RouterOS's own verifier**, and a wrong-password reject. TCP
multi-connection (`connection-count > 1`) data fan-out is implemented for
unauthenticated tests (the client joins the negotiated extra connections; the join
format is grounded against RouterOS 7.23.1); authenticated sessions stay
single-stream. See
`docs/MATRIX.md` ("Peer measurement (`btest`)") for the cell states — that is the
only status surface. v1 scope: **both** modes (client + server), **EC-SRP5 +
unauthenticated** auth, **TCP and UDP** tests. Legacy pre-6.43 double-MD5 is out of
scope.

## Why this is not `execute`

btest is **not** a RouterOS-shaped command — it issues no CLI string and there is
no `:parse` / `/console/inspect` gate. It is a **peer protocol** (TCP/UDP port
2000) that centrs speaks directly to a RouterOS bandwidth server/client (or to
another `btest.exe`/centrs). `docs/CONSTITUTION.md` adds it as a deliberate
capability axis (*measure*, see Protocol selection): the envelope, identity
resolution, and friendly-error contract still hold, but the RouterOS-command
validation gate does not apply. btest is **explicit-only** — never auto-selected,
never a downgrade target, and no other command rides it.

## Synopsis

```text
centrs btest client <router> [--protocol udp|tcp] [--direction receive|transmit|both] \
                    [--duration 15s] [--interval 1s] [--connection-count N] \
                    [--local-udp-tx-size N] [--remote-udp-tx-size N] \
                    [--local-tx-speed bps] [--remote-tx-speed bps] [--random-data] \
                    [--user U] [--password P] [--port 2000] [--csv | --format text|csv|json|yaml]

centrs btest server [--authenticate[=false]] [--user U] [--password P] \
                    [--bind 127.0.0.1] [--port 2000] \
                    [--allocate-udp-ports-from 2001] [--max-sessions 100] \
                    [--duration 1h] [--csv | --format text|csv|json|yaml]
```

## Intent

- **Speak RouterOS, not an abstraction.** Flag names mirror
  `/tool/bandwidth-test` and `/tool/bandwidth-server` verbatim (`direction`,
  `protocol`, `local-udp-tx-size`, `connection-count`, `authenticate`,
  `allocate-udp-ports-from`, …) so RouterOS muscle memory transfers. centrs adds
  only `--bind` (a server safety control) and the shared `--format`.
- **Client** connects to a RouterOS bandwidth server (or a `btest.exe`/centrs
  server), authenticates if required, runs the test in the requested direction,
  and streams live throughput reports plus a final summary.
- **Server** listens on TCP/UDP port 2000, answers the handshake, performs the
  EC-SRP5 server role when `authenticate=yes`, runs the requested test, and
  streams session events. It runs in the foreground until `--duration` elapses or
  Ctrl-C.
- **Identity resolution (client).** `<router>` resolves through the CDB exactly
  like every command (constitution: identity and CDB) — `target` and the
  `identity=`/`mac=`/`ip=` lookup keys yield the host, and `user`/`password` come
  from the record (or `__default__`, env, CLI). A target not in the CDB still
  works when `--user`/`--password` (or `CENTRS_USERNAME`/`CENTRS_PASSWORD`) are
  given. The server takes no target.
- **Validation is option-grammar validation** (constitution: validation is the
  product). centrs rejects incoherent option combinations *before* opening a
  socket — e.g. `connection-count` with `protocol=udp`, `*-udp-tx-size` with
  `protocol=tcp`, an out-of-range size (28..64000) or direction — with a
  `validation/*` / `usage/*` error. There is no `:parse` step.

## Flags

### `btest client <router>`

| Flag | RouterOS analog / default | Notes |
| ---- | ------------------------- | ----- |
| `--protocol <udp\|tcp>` | `protocol`, default `udp` | UDP measures raw throughput + loss; TCP measures goodput. |
| `--direction <receive\|transmit\|both>` | `direction`, default `receive` | `receive` = download (server→client), `transmit` = upload. |
| `--duration <dur>` | `duration` | Bounds the run; reuses `parseDuration`. Omit for open-ended (Ctrl-C). |
| `--interval <dur>` | `interval`, default `1s` | Report cadence (`20ms`..`5s`). One report frame per interval. |
| `--connection-count <n>` | `connection-count` (1..255) | **TCP only.** Parallel TCP data connections. centrs opens the negotiated extra connections (join format grounded against RouterOS 7.23.1) so throughput aggregates across streams. **Authenticated (EC-SRP5) sessions stay single-stream** — the post-auth token is not captured — and emit a `routeros/btest-connection-count-single-stream` warning. |
| `--local-udp-tx-size <n>` | `local-udp-tx-size` (28..64000) | **UDP only.** Client→server packet size. |
| `--remote-udp-tx-size <n>` | `remote-udp-tx-size` (28..64000) | **UDP only.** Server→client packet size. |
| `--local-tx-speed <bps>` | `local-tx-speed` | Cap on client→server rate (bits/sec). |
| `--remote-tx-speed <bps>` | `remote-tx-speed` | Cap on server→client rate (bits/sec). |
| `--random-data` | `random-data`, default off | Incompressible payload (defeats link compression; CPU-heavier). |
| `--user` / `--password` | `user` / `password` | Fall back to CDB / `CENTRS_*`. Required when the server has `authenticate=yes`. |
| `--port <n>` | — (default `2000`) | Control port override. |
| `--format <text\|csv\|json\|yaml>` | — (default `text`) | `text` = live human reports; `csv` = streaming CSV records; `json`/`yaml` = final summary envelope. |
| `--csv` | — | Shortcut for `--format csv`. |

### `btest server`

| Flag | RouterOS analog / default | Notes |
| ---- | ------------------------- | ----- |
| `--authenticate[=false]` | `authenticate`, **default `true`** | Require EC-SRP5 auth; `--authenticate=false` accepts anonymous clients. |
| `--user` / `--password` | — | The accepted credential when `authenticate=true` (v1: one user). Falls back to `CENTRS_*`. |
| `--bind <addr>` | **centrs-only** | Listen address; **default `127.0.0.1`**. Use `0.0.0.0` to expose on the LAN. |
| `--port <n>` | — (default `2000`) | Control-connection port. |
| `--allocate-udp-ports-from <n>` | `allocate-udp-ports-from` | Base of the UDP data-port range; default `2001` (just above the TCP/2000 control port). |
| `--max-sessions <n>` | `max-sessions` (1..1000), default `100` | Concurrent test cap; further clients get `routeros/btest-too-many-sessions`. |
| `--duration <dur>` | — | Optional auto-stop; otherwise runs until Ctrl-C. |
| `--format <text\|csv\|json\|yaml>` | — (default `text`) | `text` = human session log; `csv` = streaming CSV records; `json`/`yaml` = final summary envelope. |
| `--csv` | — | Shortcut for `--format csv`. |

## How it works

The control channel is TCP on port 2000. The server sends a hello; the client
replies with a 16-byte command packet (protocol type, direction, data type, TCP
connection count, UDP tx size, buffer size, remote/local speed limits). For a UDP
test, data then flows on the server's allocated UDP ports
(`allocate-udp-ports-from`+) and the client's `+256`-offset ports; loss is derived
from sequence gaps. For a TCP test, the bulk data rides `connection-count` TCP
connections and goodput is measured on the data stream (TCP/IP headers excluded,
matching RouterOS accounting). For multi-connection TCP the server's OK response
carries a 2-byte **session token**; the client opens `connection-count − 1`
additional connections, each presenting a 16-byte join `[token:u16 BE][0x02][0 …]`
(grounded against RouterOS 7.23.1, direction-independent) to join the same test
without re-auth, and drives them into the shared counters so throughput aggregates.
Throughput and CPU are exchanged
once per `interval` as a 12-byte **status message** on the TCP channel
(`[0x07][0x80|cpu][00 00][seq u32 LE][bytesReceived u32 LE]`). The receiver of a
transmit (server for `transmit`, both peers for `both`) sends this so the
transmitter paces from the peer's `bytesReceived`. For `direction=both` the
status frames are **interleaved into the bulk data stream** (no length framing),
so the client demuxes them out of its receive loop by their structural marker —
without that feedback the client's TX saturates the link and starves
server→client RX. RouterOS clears the CPU high bit the centrs client sets, so the
marker matches on the two reserved zero bytes, not the high bit.

### Authentication (EC-SRP5)

RouterOS ≥ 6.43 (so 7.x, including the 7.23 target) authenticates btest with
**EC-SRP5** on the Curve25519-in-short-Weierstrass curve — the same curve centrs
already ships for mac-telnet. The password never crosses the wire. The curve math
is shared from `src/protocols/ec-srp5.ts` (extracted from `mtwei.ts`); btest adds
its own control-stream framing on top. The **server** role (generate a keypair,
accept the client offer, derive the shared secret, and *verify* the client proof)
is net-new — `mtwei.ts` only implements the client. A bad proof (or a client that
will not offer EC-SRP5 against an `authenticate=yes` server) maps to
`transport/auth-failed`. Legacy pre-6.43 double-MD5 is out of scope for v1.

## Output

btest runs over time, so it emits **live records** during the run plus a final
**summary**. v1 keeps the formats simple and **defers a broader JSON-streaming
decision** — it does *not* adopt the `stream` command's NDJSON-stream-of-envelopes
contract yet (see Open questions):

- **`text`** (default) — human-readable live reports during the run
  (RouterOS / `btest.exe`-style `tx`/`rx` current/average/total; the server
  prints a session log), then a final summary line.
- **`--csv`** (shortcut for `--format csv`) — **the streaming format**: one CSV
  record per `--interval` report (client) or per session event (server), after a
  header row. Pipe-friendly for logging/plotting.
- **`--format json` / `yaml`** — a **single summary envelope** emitted at
  completion (`--duration` elapsed or Ctrl-C): the standard
  `{ ok, data, warnings, tips, error, meta }` with `meta.via = "btest"`. `data`
  aggregates the whole run — totals plus `data.reports[]` (client interval
  samples) / `data.sessions[]` (server) — so it is **lossless** against what
  `text` and `csv` streamed. It is not itself streamed (one envelope, at the end).

CSV columns — client:
`seq,direction,protocol,tx_bps,rx_bps,lost_packets,tx_bytes,rx_bytes` (one row per
interval; `seq` is the status sequence number, `tx_bytes`/`rx_bytes` the per-interval
byte counts); server:
`duration_ms,event,client,protocol,direction,user,tx_bps,rx_bps,lost_packets` (one row
per session; `tx_bps`/`rx_bps` are session averages, `lost_packets` is the UDP loss
total — 0 for TCP). A mid-run error ends
the stream and is carried in the summary envelope's `error` (`json`) or a final
`error` row (`csv`); the process exit code reflects whether the test/server
*started* cleanly.

## Server is a network listener

`centrs btest server` opens a TCP/UDP listener on port 2000 — a security-sensitive
surface (`docs/CONSTITUTION.md`, Network listeners). It is an **explicit,
foreground, user-invoked** command, **not** a daemon and **not** the proxy. It
**binds `127.0.0.1` by default** (pass `--bind 0.0.0.0` to expose on the LAN) and
**requires auth by default** (`authenticate=true`, mirroring RouterOS). The
accepted credential (`--user`/`--password`/`CENTRS_*`) and any client credentials
are redactable in bug-report output.

## Errors

- `validation/option` — an option is incompatible with the chosen
  protocol/direction (e.g. `connection-count` with `protocol=udp`,
  `*-udp-tx-size` with `protocol=tcp`) **or** out of range (UDP size `28..64000`,
  `connection-count 1..255`, `interval 20ms..5s`, `max-sessions 1..1000`). Caught
  before any socket opens; `error.context.option` names the offending flag.
- `transport/connection-refused` — no bandwidth server answered on port 2000
  (server disabled, firewalled, or wrong host). Fix: enable
  `/tool/bandwidth-server`, check the port/`--bind`.
- `transport/auth-failed` — EC-SRP5 proof rejected, or the server requires auth
  and the client offered none / wrong credentials.
- `routeros/btest-too-many-sessions` — (server) a client was refused because
  `max-sessions` is reached.
- `routeros/btest-protocol` — a malformed/unexpected control packet from the peer.

## Validation policy (CHR + loopback + btest.exe)

Decided with the user. Both cells have direct gated `CHR-passed` evidence:

- **Server cell — CHR client → centrs server** (`test/integration/btest.test.ts`):
  `@tikoci/quickchr` boots a CHR whose `/tool/bandwidth-test` dials the **host**
  (the QEMU SLIRP gateway `10.0.2.2`) where the centrs server listens on
  `--bind 0.0.0.0 --port 2000`. Guest→host needs **no hostfwd**. Proven paths are
  **TCP** (any direction — TCP is bidirectional on the outbound control connection)
  and **UDP transmit** (client→server, which the guest originates, so SLIRP NATs it
  cleanly), with unauth + EC-SRP5 and throughput cross-checked against the CHR's own
  status. **UDP receive / both** depend on the server's packets reaching the guest's
  UDP port *back* through SLIRP NAT (a one-shot smoke cycle only — see Open
  questions).
- **Client cell — centrs client → CHR `/tool/bandwidth-server`**
  (`test/integration/btest-client.test.ts`): the CHR boots with a host→guest
  `extraPorts` forward `{ name: "btest", host: 0, guest: 2000, proto: "tcp" }`, so a host TCP port
  maps onto the guest bandwidth server on 2000 (the same SLIRP inbound path that
  already carries REST/SSH — no firewall change). The centrs client dials
  `127.0.0.1:<host port>` and proves **TCP receive**, unauth and **EC-SRP5** (its
  client proof verified by RouterOS's real server verifier), a wrong-password
  reject, **TCP multi-connection fan-out** (`connection-count=4`), and **UDP
  receive/both**. The UDP server→client return needs no UDP forward: it rides the
  guest→host SLIRP gateway (`10.0.2.2:clientUdpPort`, the same path the server cell
  uses), which works because the client socket is left unconnected (#86, #88).

The fast/deterministic backstop under both is **centrs client ↔ centrs server
loopback** (`127.0.0.1`, injected sockets) covering the full client↔server matrix,
EC-SRP5 both roles, and the option-grammar rejects.
**`btest.exe` (via wine) is a coding-time grounding aid only** — used by hand
while implementing the EC-SRP5 framing and the server-side verifier; it is **not**
an integration test (it cannot run in CI) and **not** part of the long-term plan.

**Honest grounding caveat:** both cells are now directly CHR-passed, **including
TCP multi-connection fan-out** — `test/integration/btest-client.test.ts` gates a
centrs client opening `connection-count=4` against a real RouterOS
`/tool/bandwidth-server`; RouterOS accepts all 3 secondary joins and data flows on
every connection (`activeConnections: 4`). The *throughput increase* multiple
streams give is a WAN/latency property and is not observable over the near-zero-
latency SLIRP loopback, so the gate asserts the fan-out, not a higher number (the
per-connection drive is asserted deterministically by the loopback unit test).
**UDP client receive/both is now CHR-gated too** — the server→client return rides
the guest→host SLIRP gateway, no UDP forward needed (#88). The remaining fan-out
edge is **authenticated** multi-connection (capturing the EC-SRP5 post-auth token),
still single-stream.

## Open questions

- **JSON streaming is deliberately deferred.** btest does not adopt the `stream`
  command's NDJSON-stream-of-envelopes contract yet; v1 streams `text` / `csv` and
  returns a single summary envelope for `json` / `yaml`. Revisit a streaming-JSON
  shape — ideally shared with `stream` — once that contract is settled.
- **UDP receive/both through SLIRP is unproven.** Before the integration suite
  relies on server→guest UDP, a **one-shot CHR smoke test** must confirm the path
  works — i.e. that the RouterOS client originates an initial UDP/NAT probe that
  opens the SLIRP reverse mapping. Until then the gated UDP coverage is
  **transmit** (guest→host); TCP already covers both directions.
- **UDP client receive/both is now gated (#88).** The client cell
  (`test/integration/btest-client.test.ts`) lands real UDP server→client throughput:
  the return rides the guest→host SLIRP gateway (`10.0.2.2:clientUdpPort`), needing
  no UDP forward and no quickchr change — it works because the client socket is
  unconnected (#86). The remaining unproven UDP edge is the **server cell's**
  server→guest direction (host→guest, the bullet above), which *would* need a UDP
  hostfwd; `btest.exe` (wine) is the coding-time grounding peer, not CI.
- **Authenticated multi-connection stays single-stream.** Fan-out negotiates the
  session token from the unauthenticated OK; capturing the EC-SRP5 post-auth token
  to fan out authenticated tests is a follow-up. centrs warns
  (`routeros/btest-connection-count-single-stream`) when the realized connection
  count falls short of the request.

## Out of scope (v1)

Legacy pre-6.43 double-MD5 auth; the ≥3-router "test-through" topology RouterOS
recommends for measuring a *transit* device (centrs is an endpoint peer); TUI/proxy
btest frontends (later, over the stable core).
