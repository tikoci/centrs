# btest — examples

Each numbered example is an executable spec. btest is a peer protocol (no router
*command* is run), so the examples are validated by two peers — matching the
matrix's honest grounding split (`docs/MATRIX.md`, "Peer measurement (`btest`)"):

- **Gated `CHR-passed` (server cell): CHR client → centrs server** — examples
  **1–3** are the asserted set. `@tikoci/quickchr` boots a CHR; its
  `/tool/bandwidth-test` dials the host at the SLIRP gateway `$GW` (`10.0.2.2`)
  where the centrs server listens on `--bind 0.0.0.0`. No hostfwd (guest→host).
  Gated UDP coverage is **transmit** (guest-originated, so SLIRP NATs it cleanly);
  UDP **receive/both** through SLIRP is a non-asserting smoke cycle (README, Open
  questions). `test/integration/btest.test.ts` drives the CHR side with
  centrs's already-`CHR-passed` `execute`/REST path and cross-checks throughput /
  loss / direction against the CHR's own `/tool/bandwidth-test` status output
  (CHR 7.23.1, `bun run test:integration`). Examples **4** (wrong-credentials) and
  **5** (multi-connection TCP) are **designed but not yet gated** — the auth-reject
  path is covered by the loopback unit test, and example 5 is the **server-side**
  secondary-accept (distinct from the now-gated **client** fan-out in example 11),
  still a documented follow-up — so they are not part of the asserted run.
- **Gated `CHR-passed` (client cell): centrs client → CHR bandwidth-server** —
  examples **6** (TCP receive) and **8** (EC-SRP5 client role + wrong-password
  reject) are *also* asserted directly against a real RouterOS
  `/tool/bandwidth-server`, over a host→guest `tcp:2000` forward
  (`test/integration/btest-client.test.ts`, CHR 7.23.1). This is what makes the
  **client** cell `CHR-passed`: centrs's EC-SRP5 **client proof** is verified by
  RouterOS's own server verifier. Example **11** (TCP **multi-connection**
  fan-out), a TCP `direction=both` #85 regression guard, and **UDP receive/both**
  (#88 — the server→client return over the guest→host SLIRP gateway) are gated in
  the same suite.
- **Unit / loopback (client cell + codec)** — examples 6–10. centrs client ↔
  centrs server on `127.0.0.1` with injected sockets; the EC-SRP5 both-roles math
  and the pre-socket option-grammar rejects (`test/unit/btest.test.ts`). These are
  deterministic and need no router, and remain the fast backstop under the gated
  client-cell coverage above.

`btest.exe` (via wine) is **not** in this example set: it cannot run in CI, so it
is a **coding-time grounding aid** only — run by hand against the centrs client and
server while developing the EC-SRP5 framing and server verifier — not a gated
example or integration test.

`$GW` is `10.0.2.2` (the host as seen from the CHR). `$U` / `$P` are the
credentials shared by the centrs server and the CHR client. `$SRV` is the centrs
server endpoint a client dials (the loopback server in unit tests). The real
`~/.config/tikoci/winbox.cdb` is never touched.

Output formats under test (see `README.md`, Output): `text` (default, live human
reports), `--csv` (streaming CSV records), and `--format json` (a single summary
envelope at completion, with `data.sessions[]` for the server / `data.reports[]`
for the client). The examples below assert on `json` (the structured summary) or
`csv` (the stream); `text` is the human render of the same data.

## CHR client → centrs server (gated; server cell)

These examples show the **`centrs btest server`** command and the result it
produces; `test/integration/btest.test.ts` separately drives the CHR's
`/tool/bandwidth-test` against `$GW`.

### 1. Unauthenticated TCP receive

```bash
centrs btest server --authenticate=false --bind 0.0.0.0 --duration 20s --format json
```

While the server runs, the CHR executes `/tool/bandwidth-test $GW protocol=tcp
direction=receive duration=10s`. At completion the **summary envelope** is
`ok: true`, `meta.via: "btest"`, with `data.sessions[0]` =
`{ client, protocol: "tcp", direction: "transmit", user: "" }` (the server
transmits on the client's `receive`) and a non-zero aggregate tx rate;
`data.stopReason: "duration-elapsed"`. The server's measured tx is within
tolerance of the CHR's reported `rx-total-average`.

### 2. Unauthenticated UDP transmit (CSV stream)

```bash
centrs btest server --authenticate=false --bind 0.0.0.0 --duration 20s --csv
```

CHR runs `/tool/bandwidth-test $GW protocol=udp direction=transmit
local-udp-tx-size=1000 duration=10s` — client→server, which the guest originates,
so SLIRP NATs the UDP flow to the host cleanly. stdout is a CSV stream: a header
row then one record per session event, with at least one row carrying
`protocol=udp`, `direction=receive` (the server receives the client's transmit),
non-zero `rx_bps`, and a populated `lost_packets` column. UDP data rode the
allocated ports (`allocate-udp-ports-from` base). UDP **receive/both** (server→guest)
is gated behind the SLIRP smoke test and is not asserted here yet.

### 3. EC-SRP5-authenticated TCP receive

```bash
centrs btest server --authenticate --user $U --password $P --bind 0.0.0.0 --duration 20s --format json
```

CHR runs `/tool/bandwidth-test $GW protocol=tcp direction=receive user=$U
password=$P duration=10s`. The EC-SRP5 **server role** verifies the client proof;
the summary `data.sessions[0]` carries `user: "$U"`, `protocol: "tcp"`,
`direction: "transmit"` (server transmits on the client's `receive`), `ok: true`,
and non-zero throughput. This is the example that exercises the net-new
server-side EC-SRP5 verifier against real RouterOS (TCP keeps the gated path off
the SLIRP UDP-reverse-NAT question).

### 4. Wrong credentials are rejected

> *Designed, not yet gated* — the auth-reject path is asserted by the loopback
> unit test (example 8's mismatched-password case); this CHR variant is a
> documented follow-up.

```bash
centrs btest server --authenticate --user $U --password $P --bind 0.0.0.0 --duration 20s --format json
```

CHR runs `/tool/bandwidth-test $GW user=$U password=wrong …`. The server keeps
listening and finishes its run, so the summary is `ok: true` but `warnings[]`
contains a `transport/auth-failed` entry (the EC-SRP5 proof did not verify) and
`data.sessions` is empty — no session opened, no throughput. The CHR side reports
an authentication failure.

### 5. Multi-connection TCP transmit (server-side accept)

> *Designed, not yet gated* — this is the **server-side** fan-out: centrs's
> `btest server` accepting parallel secondary joins from a client. The session
> token is negotiated but centrs's server does not yet serve secondary TCP joins.
> Distinct from the **client** fan-out (example 11), which **is** implemented and
> gated. Documented follow-up; not part of the asserted run.

```bash
centrs btest server --authenticate=false --bind 0.0.0.0 --duration 20s --format json
```

CHR runs `/tool/bandwidth-test $GW protocol=tcp direction=transmit
connection-count=4 duration=10s`. The intended summary `data.sessions[0]` shows
`protocol: "tcp"`, `direction: "receive"` (server receives the client's
`transmit`) and `connectionCount: 4`; the server accepts the parallel TCP data
connections and the aggregate goodput is non-zero. Will confirm `connection-count`
is honored end to end once the fan-out lands.

## centrs client ↔ centrs server loopback (unit; client cell + codec)

### 6. Client TCP receive against a centrs server

```bash
centrs btest client $SRV --protocol tcp --direction receive --duration 3s --format json
```

With a centrs server on `$SRV` (`127.0.0.1:2000` in-test, `--authenticate=false`),
the summary envelope is `ok: true`, `meta.via: "btest"`, with `data.reports[]`
holding the per-`interval` samples (each carrying `rxBps` / `rxAvgBps`,
`direction: "receive"`) and aggregate `rxTotalAvgBps`; `data.stopReason:
"duration-elapsed"`.

### 7. Client UDP both directions (CSV stream)

```bash
centrs btest client $SRV --protocol udp --direction both --local-udp-tx-size 1000 --remote-udp-tx-size 1000 --duration 3s --csv
```

stdout is a CSV stream: a header then one row per `--interval` report, each with
non-zero `tx_bps` and `rx_bps`, a `lost_packets` column, and non-zero per-interval
`tx_bytes`/`rx_bytes`. Proves the client drives the same codec the CHR validated in
examples 1–3, and exercises the streaming CSV path.

### 8. EC-SRP5 handshake, client and server roles

```bash
centrs btest client $SRV --protocol udp --direction receive --user $U --password $P --duration 3s --format json
```

Against a centrs server started with `--authenticate --user $U --password $P`, the
client's EC-SRP5 proof verifies against the server's verifier: `ok: true`,
throughput non-zero. A run with a mismatched `--password` instead returns
`ok: false`, `error.code = "transport/auth-failed"`, and no throughput. Exercises
both EC-SRP5 roles in one process without a router.

### 9. Option-grammar reject: `connection-count` with UDP

```bash
centrs btest client $SRV --protocol udp --connection-count 4
```

`ok: false`, `error.code = "validation/option"`,
`error.context.option = "connection-count"`, and **no socket is opened**.
`connection-count` applies only to `protocol=tcp`. This is the product claim: btest
validates its option grammar before touching the network, with no `:parse` step.

### 10. Option-grammar reject: out-of-range UDP size

```bash
centrs btest client $SRV --protocol udp --local-udp-tx-size 99999
```

`ok: false`, `error.code = "validation/option"` (UDP size must be `28..64000`), no
socket opened. The same gate rejects `connection-count` outside `1..255`,
`interval` outside `20ms..5s`, and (server) `max-sessions` outside `1..1000`.

## centrs client TCP multi-connection (gated; client cell)

### 11. Multi-connection TCP receive fan-out

```bash
centrs btest client <router> --protocol tcp --direction receive --connection-count 4 --duration 4s --format json
```

Against a real RouterOS `/tool/bandwidth-server` (`authenticate=no`), centrs reads
the session token from the primary's OK and opens the 3 extra TCP data
connections, each presenting the grounded join `[token:u16 BE][0x02][0 …]`. The
summary is `ok: true` with `data.activeConnections: 4` and non-zero aggregate
throughput — real RouterOS accepted all 3 secondary joins and data flowed on every
connection (the per-connection drive is also asserted deterministically by the
loopback unit test). The *throughput increase* multiple streams provide is a
high-latency/WAN-link property and is **not** observable over the near-zero-latency
SLIRP loopback (a single TCP stream already saturates it), so the gate asserts the
fan-out itself, not a higher number. Gated in
`test/integration/btest-client.test.ts` (CHR 7.23.1). An **authenticated**
`--connection-count > 1` run instead stays single-stream (`activeConnections: 1`)
and carries a `routeros/btest-connection-count-single-stream` warning.
