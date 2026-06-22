# discover — examples

Each numbered example is an executable spec. `discover` listens on a UDP
socket; MNDP needs a real layer-2 broadcast segment, which a `user`-mode SLIRP
CHR cannot carry. The L2 fabric now comes from a second `socket-connect` NIC
plus a host bridge (`README.md`, L2 validation policy). Examples are validated
by:

- **real L2 against CHR** — examples 1 (passive discover + neighbor fields), 2
  (scan packet-count meta), and 4 (`--save` into a CDB): a CHR boots with a
  `socket-connect` NIC and `test/integration/discover.test.ts` runs the
  unmodified `discover()` path against a genuine RouterOS announcement,
  cross-checked against REST (CHR 7.23.1, `bun run test:integration`);
- the pure codec against crafted packet fixtures
  (`test/unit/mndp.test.ts`),
- the TTL cache with an injected clock (`test/unit/mndp-cache.test.ts`),
- the UDP listener over a loopback socket and the `--save` / port-in-use /
  custom-group / de-dupe / encrypted-CDB paths (examples 3, 5, 6, 7) against an
  ignored, per-test CDB path in the working tree (`test/unit/discover.test.ts`).

`$CDB` is a per-test CDB path; the real `~/.config/tikoci/winbox.cdb` is never
touched.

## discover

### 1. Passive discover with the default window

```bash
centrs discover
```

Listens for the default `15s`, broadcasting an immediate refresh then every 5s. Envelope:
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
`group=discovered`. Each saved comment carries the `source=mndp` kv token, the
`identity=`/`mac=` **lookup keys** (so the device resolves by its advertised
identity, IP, or MAC), and a free-form parenthesized detail (`board:`,
`version:`, `interface:`, `software-id:`). `meta.operation.saved` reports
`{ group, added, skipped, records }`.

### 5. Save with a custom group

```bash
centrs discover --save --group lab --cdb-file $CDB
```

New entries get `group=lab` instead of `discovered`.

### 6. De-dupe against existing records

```bash
centrs discover --save --cdb-file $CDB
```

A neighbor whose **MAC** already names a CDB entry — as a `macTarget` record's
target or a `mac=` lookup key on any record (and likewise any record sharing the
neighbor's IP target) — is skipped, never overwritten. MAC is the de-dupe key
because it is globally unique and always advertised; `identity` is not, since
factory-default devices all report `MikroTik`. The skip is reported in
`meta.operation.saved.records[].action = "skipped-existing"`; hand-curated
records win.

### 7. Save against an encrypted CDB

```bash
centrs discover --save --cdb-file $ENC_CDB --cdb-password centrs-test
```

`ok: true`. The write layer decrypts the CDB under the supplied password,
appends new neighbors, and re-encrypts with a fresh salt before the atomic
rename. The `.bak.<timestamp>` beside the CDB is the verbatim prior
ciphertext.
