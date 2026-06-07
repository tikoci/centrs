# discover

Discover RouterOS neighbors over MNDP and optionally save them into the CDB.

Status: `coded` (see `docs/MATRIX.md`). The MNDP codec, TTL cache, UDP
listener, and `discover --save` are implemented and unit-tested; the matrix
remains the only status surface. The `identity=`/`mac=` lookup-key writing and
MAC-keyed de-dupe described below are the decided target; the current `--save`
de-dupes on `target` and keeps identity/MAC in the inert detail — that gap moves
with the `devices` lookup-key work.

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

| Flag             | Default       | Meaning                                              |
| ---------------- | ------------- | ---------------------------------------------------- |
| `--timeout`      | `15s`         | Listen window before results are returned. First refresh is sent immediately. |
| `--save`         | off           | Persist discovered neighbors into the CDB.           |
| `--group`        | `discovered`  | First-class CDB group assigned to saved entries.     |
| `--port`         | `5678`        | UDP port to bind for MNDP.                            |
| `--cdb-file`     | resolved CDB  | CDB path override for `--save`.                      |
| `--cdb-password` | env/none      | Decrypt an encrypted CDB; also used to re-encrypt on `--save`. |
| `--format`       | `text`        | `text`, `json`, or `yaml`; renders the same envelope. |

`--save` without `--timeout` uses the default 15s window.

Bare `centrs discover` is **read-only** — it returns the envelope and never
writes the (WinBox-shared) CDB; `--save` is the explicit opt-in. The registry
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
  record) is **skipped, never overwritten** — hand-curated records win. Only
  genuinely new devices are added. Writes reuse the `devices` atomic write path
  (`addDevice`); the CDB is reloaded between writes so each add sees prior ones.
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

Decided (2026-06-06): the real-L2 integration path for MNDP is
`@tikoci/quickchr`'s host-side L2 capture. The host runs a TCP server and the CHR
gets a `socket-connect` NIC; QEMU streams every guest Ethernet frame to the host
length-prefixed (4-byte BE length + raw frame), and a frame written back is
injected into the guest. A small host shim bridges that frame stream to centrs's
UDP/5678 listener — capturing the CHR's MNDP announcements and injecting centrs's
refresh broadcast — a real L2 path with no root and no native raw-frame helper,
while REST/native-API keep a separate user-mode NIC with hostfwd. Prefer
`socket-connect` over `socket-mcast`: the multicast netdev is broken on macOS
(QEMU sets only `SO_REUSEADDR` where macOS needs `SO_REUSEPORT`; mcast works on
Linux/CI). Grounding: quickchr `docs/mndp.md`, `examples/mndp/`,
`test/lab/mndp/REPORT.md`.

Until that harness is wired, the CI gate stays crafted packet fixtures plus a
loopback UDP listener, and `discover / mndp` does not advance to `CHR-passed`.
The same `socket-connect` path unblocks the mac-telnet execute/terminal cells.
