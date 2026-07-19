# discover

Discover RouterOS neighbors over MNDP and optionally save them into the CDB.

Status: `CHR-passed` (see `docs/MATRIX.md`). The MNDP codec, TTL cache, UDP
listener, and `discover --save` are implemented; the real-L2 receive/decode/save
path is green against RouterOS CHR 7.23.1 via `test/integration/discover.test.ts`
(socket-connect bridge), and the network-independent paths stay unit-tested. The
matrix remains the only status surface. `--save` now writes the `identity=`/`mac=`
lookup keys and de-dupes on the MAC (both described below), so a discovered
device resolves by its advertised identity, IP, or MAC — not just the stored
`target`.

## Synopsis

```text
centrs discover [--timeout 15s] [--save] [--group discovered] \
                [--port 5678] [--cdb-file <path>] [--cdb-password <secret>] \
                [--format text|json|yaml]
```

## Intent

- MNDP is the first discovery source. It is a passive hint source, not
  authoritative inventory.
- `--save` writes discovered targets into the configured CDB with provenance
  metadata in comment kv-soup and default `group=discovered`.
- Saved records preserve enough metadata for later resolution: MAC, advertised
  identity, platform, RouterOS version when present, source, and discovery
  timestamp.
- Discovery never supplies credentials. A later `retrieve`, `execute`, or
  `devices set` must still resolve credentials from CDB, env, CLI, or prompt.

## How it works

MNDP is UDP broadcast on port `5678`; each RouterOS interface answers a refresh
with a TLV-encoded announcement (MAC, identity, version, platform, board,
uptime, software-id, interface, IPv4/IPv6). `discover`:

1. Binds a UDP socket (default `0.0.0.0:5678`) with address/port reuse so
   it can coexist with other MNDP listeners when the platform permits it.
2. Broadcasts a refresh request **immediately**, then every 5s, and listens for
   the `--timeout` window. Sending the first refresh up front (rather than after
   the initial 5s tick) is what makes a short default window viable: responders
   reply within a round-trip instead of waiting for their own ~60s passive cycle.
3. Decodes each datagram with the pure codec in `src/data/mndp.ts`, tolerating
   unknown TLV types and ignoring malformed datagrams and its own refresh echo.
4. Stores neighbors in an in-memory TTL cache keyed by MAC.
5. Returns a canonical envelope whose `data.neighbors` is sorted by MAC.

The codec is pure and the socket layer is thin and injectable, so both are
tested without a router (crafted packet fixtures + a loopback socket).

## Flags and defaults

Implemented flags (with their defaults) are generated from the CLI metadata
into [`docs/CLI.md` → discover](../../docs/CLI.md#discover); this file does
not duplicate that table. The first refresh is sent immediately, so the
`--timeout` listen window (default 15s) bounds the wait, and `--save` without
`--timeout` uses the same default window.

Bare `centrs discover` is **read-only** — it returns the envelope and never
writes the (WinBox-shared) CDB; `--save` is the explicit opt-in. When it finds
neighbors but was not given `--save`, the envelope carries a `tip/discover-save`
pointer so the read-only run advertises how to persist the result. In the
human-facing text format on an interactive terminal (TTY) `discover` also prints
a one-line "listening…" progress note to **stderr** so the listen window does not
look like a hang; `--format json|yaml` and piped/redirected runs stay silent
(stderr is exempt from the lossless-stdout rule — see
[`docs/CONSTITUTION.md`](../../docs/CONSTITUTION.md), Result envelope). The registry
surface `centrs devices discover` is the inverse: invoking `devices` means you
intend to populate it, so **`--save` is implied** there, and it is the home for
the "set default credentials so centrs starts useful" onboarding nudge. Both
paths write through the `devices` atomic write layer, so "devices is the only
writer" holds.

## MNDP cache shape and TTL policy

(Answers the former matrix open question.)

- **Shape:** an in-memory `MndpCache` (`src/data/mndp-cache.ts`) keyed by the
  lower-cased MAC address. MAC-less announcements fall back to a synthetic
  `noaddr:<identity>:<interface>` key. Each entry records the latest decoded
  neighbor plus `firstSeenAt` / `lastSeenAt` epoch-ms timestamps. The cache is
  process-local only — the CDB stays the single durable datastore.
- **TTL:** entries expire `180s` (three ~60s announce cycles) after they were
  last seen. Three cycles tolerates a couple of dropped broadcasts before a
  still-present neighbor is forgotten. Re-observing a neighbor refreshes
  `lastSeenAt` and keeps `firstSeenAt`. The clock is injectable for
  deterministic tests.

## `--save` provenance and de-dupe

- **Target:** a neighbor's CDB target is its advertised IPv4 when present
  (record type `ipAdmin`), else its MAC (record type `macTarget`). One record
  per device — the connectable address — not a MAC record plus an IP record.
- **Lookup keys:** the identifiers that are *not* the target are written as
  comment lookup keys so the device resolves by any of them (see
  `commands/devices/README.md`, Identity model): `identity=<advertised
  identity>` always, and `mac=` when the target is the IP. The advertised
  identity is therefore usable directly — `centrs retrieve <identity> …` — even
  though it is duplicative across factory-default devices.
- **Provenance:** the comment also carries the allowlisted `source=mndp` token
  plus a free-form, parenthesized detail (`discovered <iso> via MNDP (platform:
  …; board: …; version: …; interface: …; software-id: …)`). The detail is inert
  so it preserves provenance without emitting `cdb/unknown-option` warnings.
- **Group:** new entries get `group=discovered` (override with `--group`).
- **De-dupe rule:** keyed on the **MAC**, which MNDP always carries and which is
  globally unique — `identity` is *not* the de-dupe key, because factory-default
  devices all report `MikroTik`. A neighbor whose MAC already names a CDB entry
  (as the `target` of a `macTarget` record or as a `mac=` lookup key on any
  record) is **skipped, never overwritten** — hand-curated records win. A
  neighbor whose IP `target` already names an entry is likewise skipped, so a
  curated record is never clobbered. Only genuinely new devices are added. Writes
  reuse the `devices` atomic write path (`addDevice`); the CDB is reloaded between
  writes so each add sees prior ones.
- **Encrypted CDBs:** `--save` against an encrypted CDB decrypts the file under
  the loaded password, appends new neighbors, and re-encrypts with a fresh salt
  before the atomic rename. The backup beside the CDB is the verbatim prior
  ciphertext. Reading an encrypted CDB stays supported.
- **No auto-deletion / aging.** centrs never removes or rewrites a CDB record it
  did not just create in this run. Discovered records age via their discovery /
  `updated=` timestamp, and staleness is surfaced as a **tip** ("N discovered
  entries are >30d old"), never an automatic delete — deleting records from a
  WinBox-shared file unprompted is unsafe.

## Errors

- `mndp/listen-failed` — the UDP bind failed (`EADDRINUSE`, e.g. WinBox holds
  5678 without compatible port sharing; or `EACCES`). Remediation: stop the
  holder, or pass a different `--port`.
- `mndp/malformed` — the pure codec rejects a structurally invalid packet
  (too-short header or a TLV length that overruns the buffer). The listener
  ignores such datagrams rather than failing the whole scan.

## L2 validation policy

Decided (2026-06-06), wired and proven (2026-06-07): the real-L2 integration
path for MNDP is `@tikoci/quickchr`'s host-side L2 capture. The host runs a TCP
server and the CHR gets a `socket-connect` NIC; QEMU streams every guest Ethernet
frame to the host length-prefixed (4-byte BE length + raw frame), and a frame
written back is injected into the guest. A small host shim
(`test/integration/mndp-l2-bridge.ts`) bridges that frame stream to centrs's
UDP/5678 listener — lifting the UDP/5678 payload out of each frame and
re-delivering it to the **unmodified** `discover()`/`listenMndp` path, and
injecting MNDP refresh frames back over the same TCP connection so RouterOS
answers within a round-trip — a real L2 path with no root and no native
raw-frame helper, while REST/native-API keep a separate user-mode NIC with
hostfwd. centrs runs with `sendRefresh: false` here (its own broadcast cannot
reach the guest through the bridge, so the shim does the L2 injection; the
refresh-send path stays covered by the loopback unit test). Prefer
`socket-connect` over `socket-mcast`: the multicast netdev is broken on macOS
(QEMU sets only `SO_REUSEADDR` where macOS needs `SO_REUSEPORT`; mcast works on
Linux/CI). Grounding: quickchr `docs/mndp.md`, `examples/mndp/`,
`test/lab/mndp/REPORT.md`.

`test/integration/discover.test.ts` exercises this end to end on RouterOS CHR
7.23.1: it boots `["user", { type: "socket-connect", port }]`, captures a real
MNDP announcement, decodes it with centrs's codec, cross-checks
`identity`/`platform`/`board`/`version`/`mac` against REST, and `--save`s a
`macTarget`/`group=discovered`/`source=mndp` record (examples 1, 2, 4). It runs
under `bun run test:integration` (gated by `CENTRS_RUN_FAST_INTEGRATION`). The
network-independent examples (3 port-in-use, 5 custom group, 6 de-dupe, 7
encrypted CDB) are CDB/bind logic that is identical regardless of where the
neighbor came from, so they stay validated by `test/unit/discover.test.ts`
against a loopback socket and crafted fixtures.

Live-router finding worth carrying into mac-telnet: MNDP's board TLV (type 12)
advertises the short board id (`CHR`), while REST `/system/resource` `board-name`
is the verbose hardware string (`CHR QEMU Standard PC (i440FX + PIIX, 1996)`)
that *begins with* it — so cross-checks must use `startsWith`, not equality. The
same `socket-connect` bridge (with its frame-injection write-back) is the L2
harness the mac-telnet execute/terminal cells will reuse.
