# discover

Discover RouterOS neighbors over MNDP and optionally save them into the CDB.

Status: `coded` (see `docs/MATRIX.md`). The MNDP codec, TTL cache, UDP
listener, and `discover --save` are implemented and unit-tested; the matrix
remains the only status surface.

## Synopsis

```text
centrs discover [--timeout 60s] [--save] [--group discovered] \
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
  `devices edit` must still resolve credentials from CDB, env, CLI, or prompt.

## How it works

MNDP is UDP broadcast on port `5678`; each RouterOS interface answers a refresh
with a TLV-encoded announcement (MAC, identity, version, platform, board,
uptime, software-id, interface, IPv4/IPv6). `discover`:

1. Binds a UDP socket (default `0.0.0.0:5678`) with address/port reuse so
   it can coexist with other MNDP listeners when the platform permits it.
2. Broadcasts a refresh request every 5s and listens for the `--timeout`
   window.
3. Decodes each datagram with the pure codec in `src/data/mndp.ts`, tolerating
   unknown TLV types and ignoring malformed datagrams and its own refresh echo.
4. Stores neighbors in an in-memory TTL cache keyed by MAC.
5. Returns a canonical envelope whose `data.neighbors` is sorted by MAC.

The codec is pure and the socket layer is thin and injectable, so both are
tested without a router (crafted packet fixtures + a loopback socket).

## Flags and defaults

| Flag             | Default       | Meaning                                              |
| ---------------- | ------------- | ---------------------------------------------------- |
| `--timeout`      | `60s`         | Listen window before results are returned.           |
| `--save`         | off           | Persist discovered neighbors into the CDB.           |
| `--group`        | `discovered`  | First-class CDB group assigned to saved entries.     |
| `--port`         | `5678`        | UDP port to bind for MNDP.                            |
| `--cdb-file`     | resolved CDB  | CDB path override for `--save`.                      |
| `--cdb-password` | env/none      | Decrypt an encrypted CDB; also used to re-encrypt on `--save`. |
| `--format`       | `text`        | `text`, `json`, or `yaml`; renders the same envelope. |

`--save` without `--timeout` uses the default 60s window.

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
  (record type `ipAdmin`), else its MAC (record type `macTarget`).
- **Provenance:** the comment carries the allowlisted `source=mndp` kv token
  plus a free-form, parenthesized detail (`discovered <iso> via MNDP (identity:
  …; platform: …; board: …; version: …; mac: …; interface: …; software-id: …)`).
  Only `source=mndp` is parsed by the comment kv-soup; the detail is inert so it
  preserves provenance without emitting `cdb/unknown-option` warnings later.
- **Group:** new entries get `group=discovered` (override with `--group`).
- **De-dupe rule:** a neighbor whose target already names a CDB entry is
  **skipped, never overwritten** — hand-curated records win. Only new targets
  are added. Writes reuse the `devices` atomic write path (`addDevice`); the CDB
  is reloaded between writes so each add sees the prior additions.
- **Encrypted CDBs:** `--save` against an encrypted CDB decrypts the file under
  the loaded password, appends new neighbors, and re-encrypts with a fresh salt
  before the atomic rename. The backup beside the CDB is the verbatim prior
  ciphertext. Reading an encrypted CDB stays supported.

## Errors

- `mndp/listen-failed` — the UDP bind failed (`EADDRINUSE`, e.g. WinBox holds
  5678 without compatible port sharing; or `EACCES`). Remediation: stop the
  holder, or pass a different `--port`.
- `mndp/malformed` — the pure codec rejects a structurally invalid packet
  (too-short header or a TLV length that overruns the buffer). The listener
  ignores such datagrams rather than failing the whole scan.

## L2 validation policy

Proposed pending sign-off: `discover` stays validated at the protocol/socket
layer until centrs has a maintained raw-L2 integration helper. MNDP needs a real
layer-2 broadcast segment; the current `@tikoci/quickchr` integration entry
point uses QEMU user-mode SLIRP, which does not carry L2 broadcast traffic, and
Bun has no raw BPF/AF_PACKET socket API for receiving host Ethernet frames. A
future libpcap/socket_vmnet shim can provide the real-router L2 proof, but the
current CI gate remains crafted packet fixtures plus a loopback UDP listener.

This means `discover / mndp` must not advance to `CHR-passed` until every
example in `commands/discover/examples.md` runs against a real L2 segment.
The same L2 blocker also applies to mac-telnet execute/terminal cells.
