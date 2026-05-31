# discover — examples

Each numbered example is an executable spec. `discover` listens on a UDP
socket; MNDP needs a real layer-2 broadcast segment, which the current
`user`-mode SLIRP CHR harness does not carry. Until an L2 fabric exists in CI
(tracked as the open question in `README.md`), these examples are validated by:

- the pure codec against crafted packet fixtures
  (`test/unit/mndp.test.ts`),
- the TTL cache with an injected clock (`test/unit/mndp-cache.test.ts`),
- the UDP listener over a loopback socket and `--save` against an ignored,
  per-test CDB path in the working tree (`test/unit/discover.test.ts`).

`$CDB` is a per-test CDB path; the real `~/.config/tikoci/winbox.cdb` is never
touched.

## discover

### 1. Passive discover with the default window

```bash
centrs discover
```

Listens for the default `60s`, broadcasting a refresh every 5s. Envelope:
`ok: true`, `meta.via: "mndp"`, `data` is `{ count, neighbors }` with
`neighbors` sorted by MAC. Each neighbor carries `mac`, optional `identity`,
`version`, `platform`, `board`, `uptimeSeconds`, `softwareId`,
`interfaceName`, `ipv4`, `ipv6`, plus `firstSeenAt` / `lastSeenAt`.

### 2. Short scan with JSON output

```bash
centrs discover --timeout 5s --format json
```

`meta.operation.timeoutMs` is `5000`; `meta.operation.packetsReceived`,
`packetsDecoded`, and `packetsRejected` summarize the scan. The JSON envelope
is the lossless representation the text format renders.

### 3. Bind a non-default port

```bash
centrs discover --port 5678
```

Binding a port already held (e.g. by WinBox, without `SO_REUSEPORT`) errors
with `mndp/listen-failed` and an actionable remediation.

## discover --save

### 4. Save discovered neighbors into the CDB

```bash
centrs discover --save --cdb-file $CDB
```

New neighbors are added through the `devices` atomic write path with
`group=discovered`. Each saved comment contains the `source=mndp` kv token and
free-form provenance (`identity:`, `board:`, `version:`, `mac:`, …).
`meta.operation.saved` reports `{ group, added, skipped, records }`.

### 5. Save with a custom group

```bash
centrs discover --save --group lab --cdb-file $CDB
```

New entries get `group=lab` instead of `discovered`.

### 6. De-dupe against existing records

```bash
centrs discover --save --cdb-file $CDB
```

A neighbor whose target (IPv4, else MAC) already names a CDB entry is skipped,
never overwritten. The skip is reported in
`meta.operation.saved.records[].action = "skipped-existing"`; hand-curated
records win.

### 7. Save against an encrypted CDB is blocked

```bash
centrs discover --save --cdb-file $ENC_CDB --cdb-password centrs-test
```

Errors with `cdb/encrypted-write-unverified`. Reading an encrypted CDB stays
supported; encrypted writes are not yet verified to round-trip and are
refused rather than risk corrupting the file WinBox reads.
