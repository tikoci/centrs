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
| execute  | `CHR-passed`  | `CHR-passed`  | `CHR-passed`  | `CHR-passed`  | —             | —             | `not-started` | `not-started`    |
| terminal | —             | —             | `CHR-passed`  | `CHR-passed`  | —             | —             | —             | —                |
| transfer | `CHR-passed`  | `CHR-passed`  | `CHR-passed`  | —             | —             | —             | —             | —                |
| devices  | —             | —             | —             | —             | —             | —             | —             | —                |
| discover | —             | —             | —             | —             | —             | `CHR-passed`  | —             | —                |
| check    | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started`    |
| config   | —             | —             | —             | —             | —             | —             | —             | —                |

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
wire format, the MAC-keyed de-dupe, TTL/timeout defaults, the live board-TLV
finding (short board id vs the verbose REST `board-name`), and the L2 validation
policy are documented in `commands/discover/README.md`.

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

`transfer` is `CHR-passed` for `rest-api`/`native-api`: `src/transfer.ts` (verbs
`upload`/`download`/`list`/`remove`/`mkdir`/`copy`, size/direction-aware method
selection, leading-slash normalization, the `print`-probe existence guard, and
`--verify`/`--no-verify`) plus `src/cli/transfer.ts` (with the top-level
`upload`/`download` aliases). Every `/file` op rides the shared
`ProtocolAdapter` `execute`/`list` seam over both transports. Unit coverage is
`test/unit/transfer.test.ts` (path normalization, method-selection gating,
shape validation, and the REST round-trip wire shape via mocked `fetch`). The
cells carry small writes (`/file/set contents`, ≤60 KB) and all reads (chunked
`/file/read`). `test/integration/transfer.test.ts` is **green against a real CHR
7.23.1** (110 assertions): the rest + native round-trip, list + filters,
validate-before-write, device file management (mkdir/copy/remove), leading-slash
normalization, the >60 KB rejection, the error contract (missing file, bad creds,
conflicting flags), the stdin/stdout/default-local forms (examples 8–10), the
native `N1`–`N4` mirror, the sftp `S1`–`S5` round-trip, example 17 (chunked REST
read of an sftp-seeded >60 KB file), and the residual gating (scp/fetch
not-implemented, ftp gated) — which confirmed the `/file`
`get`/`set`/`add`/`copy`/`remove` wire shapes and the SFTP subsystem on real
RouterOS. Examples 8–10 close via the subprocess harness
(`test/integration/cli-process.ts`), which drives the real CLI binary so piped
stdin, raw `process.stdout` bytes, and cwd are exercised — the in-process `runCli`
console capture cannot reach those. Example 17 closed earlier (the sftp path seeds
the >60 KB file, so the fetch hack is gone), so every example is now green.

`transfer / ssh` is `CHR-passed` for **sftp**, the first SSH consumer. This
deliberately re-scopes the earlier "SSH lands as one unit" plan: the SSH
*transport base* lands here as a self-contained **SFTP transfer client**
(`src/protocols/sftp.ts`, the host OpenSSH `sftp` subsystem); `execute / ssh` and
`terminal / ssh` both layer on after (below — all three SSH cells are now
`CHR-passed`). **CHR-grounded correction:** RouterOS's SSH server has no
pseudo-tty, but a single-line `ssh user@host "<command>"` *does* run on the console
and return clean output — so `execute / ssh` needs no interactive-shell reader (the
earlier "no exec channel" framing was wrong); `terminal / ssh` execs `ssh` with
inherited stdio for the interactive relay. The single
`ssh` grid column still carries **two methods**: **sftp is built** (default secure;
its `stat`/`readdir`/partial ops drive the existence check, `--verify`, and
`list`/`remove`/`mkdir`), while **scp stays a deliberate later pass** behind
`--via scp` (a dumb byte-stream — kept only because some locked-down environments
expose nothing else). `src/transfer.ts` selects sftp via the shared `FileBackend`
seam (rest/native vs sftp), and the SSH host-key trust rides the unified
`--insecure` knob (see `docs/CONSTITUTION.md`, Transport trust). The sftp path is
**green against real CHR 7.23.1** (`test/integration/transfer.test.ts`, S1–S5: a
key-auth round-trip, the >60 KB upload REST cannot do, list/mkdir/remove). **CHR
finding:** RouterOS's sftp `ls -l` does not report a
reliable byte size, so the sftp `--verify size` trusts the SFTP transfer guarantee
(a partial `put`/`get` errors) rather than re-reading a size. On-device `copy` has
no SFTP primitive and stays on rest/native.

`execute / ssh` is `CHR-passed`, the second SSH consumer. RouterOS grants no
pseudo-tty, but `ssh user@host "<command>"` runs one single-line console command
and returns **clean** output (no prompt / ANSI / echo — spike-grounded on CHR
7.23.1), so this is a **per-command batch client** (`SshExecClient` in
`src/protocols/ssh.ts`: one `ssh` invocation per command, like the SFTP batch
client), not a screen-emulating reader. The shared host-`ssh` plumbing (key/trust
option builder `sshCommonOptions`, connect-error mapping) is extracted from
`sftp.ts` into `ssh.ts`; the `SshExecAdapter` (`adapter.ts`) is a console transport
like mac-telnet (execute-only; structured reads/inspect unsupported). The execute
orchestrator routes ssh through the **same single console `:put [:parse …]`** gate
as mac-telnet — over SSH it returns the identical `(evl …)` / `bad parameter
<name>` strings, so `classifyParseResult` is reused verbatim — then runs the raw
CLI line; a successful write prints nothing (like mac-telnet). `--ssh-key` /
`--insecure` thread through `resolveAuth` + the execute config. Green via
`test/integration/execute-ssh.test.ts` (S1–S4: read, multi-line read,
REST-verified write, the `:parse` unknown-attribute reject) on CHR 7.23.1; unit
coverage for the client/output-cleanup/error-mapping is `test/unit/ssh.test.ts`.

`terminal / ssh` is `CHR-passed`, the third and last SSH consumer. RouterOS grants
no pseudo-tty, but `ssh user@host` (no command) opens the interactive console — so
`terminal / ssh` **execs the host `ssh` with inherited stdio** and lets the OS
relay the already-clean no-PTY stream; there is no screen emulation, and centrs's
value is resolving the target/key/trust and building the argv
(`buildSshTerminalArgv` in `src/terminal.ts`, reusing `sshCommonOptions`). No `-t`
is passed (a real TTY makes `ssh` request a PTY on its own; forcing `-tt` hangs
RouterOS). `runTerminal` returns the exit code now: mac-telnet returns 0 on a clean
console close, ssh returns `ssh`'s code (a no-PTY console closed by EOF can exit
non-zero — the device/ssh's result, not a centrs failure). A **host target
defaults to ssh**, a MAC target to mac-telnet. Green via
`test/integration/terminal-ssh.test.ts` (TS1: batch relay over the real binary
through the subprocess harness; TS2: the rest/native capability gate) on CHR
7.23.1; argv construction is unit-tested (`test/unit/terminal.test.ts`). **All SSH
cells (transfer/execute/terminal) are now `CHR-passed`.** The no-PTY limitation
(no multi-line brace blocks over SSH) is the device's, documented in
`commands/terminal/README.md`.

`fetch` (centrs-as-HTTP-server + `/tool/fetch`) is a **deferred, explicit-only
method within the rest-api/native-api cells**, not a grid column — it needs
inbound reachability (router → centrs) so it is never auto-selected.

`config` is `designed` and transport-less (like `devices`), so its grid row
stays `—`. `commands/config/README.md` describes the `centrs.env` + `__default__`
front-end (interactive first-time setup plus `config get/set/reset/print`); no
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
| api (TS) | `CHR-passed` | `src/index.ts` | Root surface; everything else adapts it. |
| cli | `coded` | `src/cli/` | `retrieve`/`execute`/`transfer`/`terminal`/`devices`/`discover`/`btest` wired. |
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
7. **ssh** for transfer/execute/terminal — third transport. **Re-scoped (decided
   with the user): land it transfer-first.** The SSH transport base shipped as the
   **SFTP transfer client** (`transfer / ssh`, `CHR-passed` — `src/protocols/sftp.ts`
   over host OpenSSH); the `ssh-key` (`--ssh-key`/`CENTRS_SSH_KEY`/comment-kv) and
   `insecure` settings landed **with** it. **`execute / ssh` is now `CHR-passed`**
   too (a per-command `ssh host "<command>"` batch client — a CHR spike disproved
   the "needs an interactive-shell reader" assumption; RouterOS returns clean
   no-PTY output, so it reuses the mac-telnet `:parse` gate, no reader).
   **`terminal / ssh` is now `CHR-passed`** as well (exec the host `ssh` with
   inherited stdio — no screen emulation; a host target defaults to ssh). **All
   three SSH cells are done.** See `commands/terminal/README.md`
   (RouterOS SSH surface)
   for the device-side option alignment and residual unknowns.
8. **mac-telnet** for execute/terminal — L2 path, default execute route for
   unresolved MAC targets. `execute / mac-telnet` **and** `terminal / mac-telnet`
   are both **`CHR-passed`** (console reader + UDP transport + adapter; execute
   examples 19–21, terminal T1–T3; byte-counter retransmit + empty-ACK keepalive
   via `MacTelnetSession.tick`). Remaining (optional): the ~10s prime-latency fix
   (cursor-tracking DSR emulator) and a full-TTY terminal test under a real PTY.
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
