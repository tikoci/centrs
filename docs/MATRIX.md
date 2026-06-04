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
| execute  | `CHR-passed`  | `CHR-passed`  | `not-started` | `not-started` | —             | —             | `not-started` | `not-started`    |
| terminal | —             | —             | `not-started` | `not-started` | —             | —             | —             | —                |
| devices  | —             | —             | —             | —             | —             | —             | —             | —                |
| discover | —             | —             | —             | —             | —             | `coded`       | —             | —                |
| check    | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started`    |

`devices` does not use a transport in the protocol sense, so its grid row
stays `—`. Its cell state is `CHR-passed`: the read subset (`list`, `show`,
`groups`), the CDB mutation surface (`add`, `set`, `remove`; `edit` is reserved
for the future interactive editor and reports `usage/not-implemented`), `<router>`
lookup-key resolution (`identity`/`mac`/`ip`), the `(target, user)` record
identity, ambiguity / `--match` (`user=`/`target=`/record-type), the
`--profile-none`/`--profile-own` sentinels, and the provenance/override examples
are implemented in `src/devices.ts` and green under `bun run test:integration`
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
`tip/credentials-missing` (example 40). The whole decided `devices` redesign is
now landed; the remaining open items (ARP test scheme, CLI verb aliases) are
tracked in `commands/devices/README.md`.

`discover` is `coded`: the MNDP wire codec (`src/data/mndp.ts`), the
TTL-expiring neighbor cache (`src/data/mndp-cache.ts`), the UDP listener, and
`discover --save` (which persists through `devices`' `addDevice` write layer)
live in `src/discover.ts` and are green under `bun test`. The codec is tested
against crafted packet fixtures and the listener against a loopback socket, so
no router is required. It advances to `CHR-passed` only once every example in
`commands/discover/examples.md` is green against a real layer-2 segment via
`bun run test:integration` — which needs an L2 fabric the CI runner does not
yet provide (same blocker as mac-telnet). Flags, TTL/timeout defaults, and the
`group=discovered` convention live in `commands/discover/README.md`.

There is no `update` command: `execute` is the single read/write surface for
RouterOS add/set/remove, and `retrieve` stays read-only. See
`docs/CONSTITUTION.md` (protocol selection).

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
- **mac-telnet** (`src/protocols/mac-telnet.ts`): packet/control codec
  (direction-aware header, control blocks, little-endian terminal dims), MD5
  password auth, and the session state machine (start → auth → ready → data),
  with MTWEI/EC-SRP detected and rejected as unsupported. Covered by
  `test/unit/mac-telnet.test.ts` against a scripted peer. Real-router L2
  validation is still gated on the open question below.

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
10. **discover / mndp** — `discover --save --timeout 60s` populates CDB entries
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
| SNMP MIB cache policy | retrieve / snmp | Decide cache location, invalidation, RouterOS version/channel matching, and offline behavior for MIB-name lookup. |
| Bug-report rendering: inline flag, separate command, both? | cross-cutting | Constitution says envelope is rich enough; rendering deferred until needed. |
| L2 in CI: how to fake L2 net for mac-telnet on Linux runner | execute / mac-telnet, terminal / mac-telnet | quickchr supports L2 netdevs (`vmnet-shared`/`vmnet-bridged` on macOS, `tap`, `socket-mcast`), but `startIntegrationChr()` uses `user`-mode SLIRP with hostfwd, which does not carry L2 broadcast/MAC-Telnet. Real-router validation also needs raw L2 frame I/O from the host (BPF on macOS / AF_PACKET on Linux) on an interface sharing the CHR's L2 segment — Bun exposes no raw-L2 socket, so a native helper (libpcap binding or socket_vmnet + a small frame shim) is required. Until then, mac-telnet is covered at the protocol layer by `test/unit/mac-telnet.test.ts` against a scripted peer. Must still cover unresolved-MAC default behavior. |
| RoMON / WinBox Terminal validation and CI | execute / romon, execute / winbox-terminal | Lower priority than mac-telnet; need reference tooling and typed failure mapping before advancing. |

When a question is answered, fold the answer into the relevant
`commands/<name>/README.md` or `docs/CONSTITUTION.md`, then delete the row.
