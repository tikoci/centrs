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
| execute  | `CHR-passed`  | `CHR-passed`  | `not-started` | `not-started` | —             | —             | `not-started` | `not-started`    |
| terminal | —             | —             | `not-started` | `not-started` | —             | —             | —             | —                |
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
- **mac-telnet** (`src/protocols/mac-telnet.ts` + `src/protocols/mtwei.ts`):
  packet/control codec (direction-aware header, control blocks, little-endian
  terminal dims), the session state machine (start → auth → ready → data), and
  **both** auth methods — classic MD5 *and* MTWEI (EC-SRP over a custom
  Curve25519-in-Weierstrass form, `mtwei.ts`). The transport base is **validated
  over real L2 against stock CHR 7.23** (`test/integration/mac-telnet.test.ts`,
  quickchr `socket-connect` host-side L2 capture via `mactelnet-l2-bridge.ts`):
  the MTWEI login completes end to end (proof accepted, console session opens,
  data flows both ways), and classic MD5 is refused by the device → mapped to
  `transport/auth-failed`. Unit coverage: `test/unit/mtwei.test.ts` (EC-SRP math,
  incl. order·G = ∞ and a node-crypto identity-hash oracle; the engine is
  byte-identical to the `mtwei.c` / WinBox EC-SRP5 references) and
  `test/unit/mac-telnet.test.ts` (handshake + MTWEI offer + auth-failure
  detection against a scripted peer). **Key findings (folded into the command
  specs):** (1) current RouterOS *requires* MTWEI — it offers a 16-byte MD5 salt
  to a classic client but rejects the MD5 proof for valid credentials, so the
  client offers MTWEI by default; (2) `END_AUTH` does **not** mean success — a
  failed login also sends `END_AUTH`, then a "Login failed" message + `END`, so
  success is confirmed only when real terminal output arrives. **Remaining
  (Phase 1, command wiring):** the RouterOS console opens with a
  terminal-identification query and a readline prompt, so `execute`/`terminal`
  over mac-telnet need terminal-query handling + echo/prompt parsing to capture
  clean command output. The transport, auth, and bidirectional data path are
  proven; the command cells stay `not-started` until that glue lands.

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
   unresolved MAC targets.
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

## Open questions (decisions needed before the affected cell can advance)

| Question | Affects cell | Notes |
| -------- | ------------ | ----- |
| RoMON / WinBox Terminal validation and CI | execute / romon, execute / winbox-terminal | Lower priority than mac-telnet; need reference tooling and typed failure mapping before advancing. |

Recently closed (folded into the specs): SNMP MIB-cache policy → `commands/retrieve/README.md`; bug-report rendering (inline `--bug-report` flag, no separate verb) → `docs/CONSTITUTION.md`; L2-in-CI for mac-telnet/MNDP (quickchr `socket-connect` host-side L2 capture; `socket-mcast` is macOS-broken) → `commands/discover/README.md` + `commands/execute/README.md`.

When a question is answered, fold the answer into the relevant
`commands/<name>/README.md` or `docs/CONSTITUTION.md`, then delete the row.
