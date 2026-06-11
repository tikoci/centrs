# transfer — examples

Each numbered example is an executable spec. The integration test under
`test/integration/transfer.test.ts` runs every example against a CHR booted by
`@tikoci/quickchr`. If a line here is not exercised by a test, the test file is
wrong; if a line passes only with `validate=false`, the **implementation** is
wrong (see `docs/CONSTITUTION.md`).

Conventions (provided by the harness):

- `$R` is `<host>:<rest-port>`; `$U` / `$P` are CHR credentials.
- `$A` is `<host>` and `$API_PORT` is the native-API port (`chr.ports.api`) for
  `--via native-api`.
- `$SRC` is a small local text file (~2 KB) the harness creates; `$TMP` is a
  scratch directory for downloads. `$BIG` is a local file **larger than 60 KB**.
- Device-side paths are **bare** (a CHR has no `flash` disk, so everything
  persists for the session); the harness removes `centrs-*` test files between
  runs. The CHR free license caps throughput at 1 Mb/s, so fixtures stay small —
  the proof is correctness (a byte-exact round-trip), not throughput.

The first coded pass is `rest`/`native` only (no SSH dependency). `sftp`/`scp`/
`fetch`/`ftp` examples assert their *current* contract (not-implemented / gated)
and flip to real round-trips when their transport lands — exactly as
`retrieve`'s `--query` examples assert `validation/not-implemented` today.

## REST round-trip (the CI proof)

### 1. Upload a small file (auto → rest)

A ≤60 KB upload needs no `--via`; auto-selection uses the REST family.

```bash
centrs transfer $R upload $SRC centrs-up.txt --username $U --password $P --json
```

Envelope: `ok: true`, `data.op="upload"`, `data.remote="centrs-up.txt"`,
`data.bytes` equals the size of `$SRC`, `data.verified="size"`,
`meta.via="rest-api"`.

### 2. Download it back (round-trip)

```bash
centrs transfer $R download centrs-up.txt $TMP/down.txt --username $U --password $P --json
```

Envelope: `ok: true`, `data.op="download"`. The byte content of `$TMP/down.txt`
is **identical** to `$SRC` — this is the small-file round-trip that gates
`CHR-passed`.

## List (sugar over `retrieve /file`)

### 3. List files

```bash
centrs transfer $R list --username $U --password $P --json
```

Envelope: `data` is the `/file` row array (same shape as `retrieve /file`) and
includes a row with `name="centrs-up.txt"`.

### 4. Filter by type

```bash
centrs transfer $R list --type file --username $U --password $P --json
```

Envelope: every returned row has a file `type` (no `directory`/`disk` rows).

### 5. Filter by name glob

```bash
centrs transfer $R list --name 'centrs-*' --username $U --password $P --json
```

Envelope: every row's `name` matches the glob; `centrs-up.txt` is present.

## Validate before write

### 6. Refuse overwrite without `--force`

Re-uploading onto an existing remote path fails the precondition probe (centrs
`stat`s the target via `/file/print`) **before** writing.

```bash
centrs transfer $R upload $SRC centrs-up.txt --username $U --password $P --json
```

Envelope: `ok: false`, `error.code="usage/target-exists"`. The existing file is
unchanged.

### 7. `--force` overwrites

```bash
centrs transfer $R upload $SRC centrs-up.txt --force --username $U --password $P --json
```

Envelope: `ok: true`, `data.op="upload"`.

## Defaults and piping

### 8. Omitted local on download → basename in the current directory

```bash
centrs transfer $R download centrs-up.txt --username $U --password $P --json
```

Writes `./centrs-up.txt`; envelope `data.local` ends in `centrs-up.txt`.

### 9. Download to stdout (`-`)

Payload bytes go to **stdout**; the human/JSON summary goes to stderr, so the
two never interleave.

```bash
centrs transfer $R download centrs-up.txt - --username $U --password $P
```

stdout is byte-identical to `$SRC`.

### 10. Upload from stdin (`-`)

```bash
printf 'hello-centrs' | centrs transfer $R upload - centrs-stdin.txt --username $U --password $P --json
```

Envelope: `ok: true`, `data.bytes=12`. A follow-up `download centrs-stdin.txt -`
emits `hello-centrs`.

## Device file management

### 11. mkdir

```bash
centrs transfer $R mkdir centrs-dir --username $U --password $P --json
```

Envelope: `ok: true`. A subsequent `list --type directory` includes
`name="centrs-dir"`.

### 12. Upload into a directory

```bash
centrs transfer $R upload $SRC centrs-dir/nested.txt --username $U --password $P --json
```

Envelope: `ok: true`, `data.remote="centrs-dir/nested.txt"`.

### 13. On-device copy

```bash
centrs transfer $R copy centrs-dir/nested.txt centrs-dir/copy.txt --username $U --password $P --json
```

Envelope: `ok: true`, `data.op="copy"`. `list --name 'centrs-dir/*'` shows both
`nested.txt` and `copy.txt`.

### 14. Remove

```bash
centrs transfer $R remove centrs-dir/copy.txt --username $U --password $P --json
```

Envelope: `ok: true`, `data.op="remove"`. The file no longer appears in `list`.

## Path handling

### 15. Leading-slash normalization

A leading `/` is accepted and normalized away, so `/centrs-up.txt` and
`centrs-up.txt` are the same target.

```bash
centrs transfer $R download /centrs-up.txt $TMP/slash.txt --username $U --password $P --json
```

Envelope: `ok: true`; `$TMP/slash.txt` is identical to `$SRC`, and
`data.remote="centrs-up.txt"` (no leading slash on the wire).

## Integrity

### 16. `--no-verify` skips the size check

```bash
centrs transfer $R upload $SRC centrs-no-verify.txt --no-verify --username $U --password $P --json
```

Envelope: `ok: true`, `data.verified="off"`.

## Large file over REST (chunked read scales)

The harness seeds a >60 KB device file `centrs-big.bin` by having the CHR
`/tool/fetch` it from a temporary host HTTP server reachable at the QEMU user-net
gateway (`10.0.2.2`) — the same plumbing the deferred `fetch` method will
productize.

### 17. Download >60 KB via chunked `/file/read` (auto → rest)

```bash
centrs transfer $R download centrs-big.bin $TMP/big.bin --username $U --password $P --json
```

Envelope: `ok: true`, `meta.via="rest-api"`, `data.bytes` equals the seeded size
(>60 KB). `$TMP/big.bin` is byte-identical to the seed — proving the chunked read
reassembles correctly across `/file/read` calls.

## Error / transport contract

### 18. `--via rest` upload over 60 KB is rejected up front

REST cannot write past 60 KB, and an explicit `--via` is never silently
downgraded.

```bash
centrs transfer $R upload $BIG centrs-too-big.txt --via rest --username $U --password $P --json
```

Envelope: `ok: false`, `error.code="transport/unsupported-operation"`. No partial
file is created on the device.

### 19. Download a missing remote file

```bash
centrs transfer $R download centrs-does-not-exist.txt $TMP/x --username $U --password $P --json
```

Envelope: `ok: false`, `error.code` in the `routeros/*` family (RouterOS's own
"no such item" surfaced through the menu).

### 20. Bad credentials

```bash
centrs transfer $R list --username wrong --password wrong --json
```

Envelope: `ok: false`, `error.code="transport/auth-failed"`, `details_url`
populated.

### 21. Conflicting flags

```bash
centrs transfer $R upload $SRC centrs-up.txt --verify size --no-verify --username $U --password $P --json
```

Rejected before any network call with `usage/conflicting-flags`.

## native-api (`--via native-api`)

The same contract over the RouterOS binary API. Exercised by
`test/integration/transfer.test.ts` against the native-API port.

### N1. Upload small over native-api

```bash
centrs transfer $A upload $SRC centrs-nv.txt --via native-api --port $API_PORT --username $U --password $P --json
```

Envelope: `ok: true`, `meta.via="native-api"`.

### N2. Download small over native-api (round-trip)

```bash
centrs transfer $A download centrs-nv.txt $TMP/nv.txt --via native-api --port $API_PORT --username $U --password $P --json
```

`$TMP/nv.txt` is identical to `$SRC`.

### N3. List over native-api

```bash
centrs transfer $A list --via native-api --port $API_PORT --username $U --password $P --json
```

Envelope: `data` is the `/file` row array; includes `centrs-nv.txt`.

### N4. native-api upload over 60 KB is rejected

Same 60 KB write cap as REST (it is a `/file` menu limit, not REST-specific).

```bash
centrs transfer $A upload $BIG centrs-too-big.txt --via native-api --port $API_PORT --username $U --password $P --json
```

Envelope: `ok: false`, `error.code="transport/unsupported-operation"`.

## Pending transports (contract defined; flips when the transport lands)

### P1. `--via sftp` before the SSH transport lands

```bash
centrs transfer $R upload $SRC centrs-up.txt --via sftp --username $U --password $P --json
```

Envelope: `ok: false`, `error.code="usage/not-implemented"`. Replaced by a real
round-trip when `terminal/ssh` lands (`sftp` becomes the large-upload default).

### P2. `--via scp` (follow-on pass after sftp)

```bash
centrs transfer $R upload $SRC centrs-up.txt --via scp --username $U --password $P --json
```

Envelope: `ok: false`, `error.code="usage/not-implemented"`.

### P3. `--via fetch` (deferred, explicit-only)

```bash
centrs transfer $R upload $BIG centrs-up.bin --via fetch --username $U --password $P --json
```

Envelope: `ok: false`, `error.code="usage/not-implemented"`.

### P4. `--via ftp` without the unsafe-protocol opt-in

`ftp` is cleartext, so it is gated behind `ALLOW_UNSAFE_PROTOCOLS=ftp` and never
chosen silently.

```bash
centrs transfer $R upload $SRC centrs-up.txt --via ftp --username $U --password $P --json
```

Envelope: `ok: false`, the error reports the protocol is gated (the cleartext-FTP
opt-in is absent). When `ALLOW_UNSAFE_PROTOCOLS=ftp` is set but the method is not
yet built, it is `usage/not-implemented` instead.
