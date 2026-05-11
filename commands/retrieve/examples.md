# retrieve — examples

Each numbered example is an executable spec. The integration test under
`test/integration/rest-retrieve.test.ts` runs every example against a CHR
booted by `@tikoci/quickchr`. If a line here is not exercised by a test, the
test file is wrong; if a line passes only with `validate=false`, the
**implementation** is wrong (see `docs/CONSTITUTION.md`).

`$R` is `<host>:<rest-port>` resolved by quickchr.
`$U` / `$P` are CHR credentials provided by the test harness.

## Singletons (read a single record)

### 1. /system/resource

Must succeed with `validate=true` (default).

```bash
centrs retrieve $R /system/resource --username $U --password $P
```

Envelope: `ok: true`, `data` is an object, `meta.via=rest-api`,
`meta.validation.source=/console/inspect`.

### 2. /system/identity

Same shape, different menu.

```bash
centrs retrieve $R /system/identity --username $U --password $P
```

## Lists (read an array of rows)

### 3. /ip/address

Empty or populated, both must succeed with `validate=true`.

```bash
centrs retrieve $R /ip/address --username $U --password $P
```

Envelope: `ok: true`, `data` is an array.

### 4. /interface

List of interfaces present on a default CHR.

```bash
centrs retrieve $R /interface --username $U --password $P
```

## Attribute projection

### 5. Single --attribute on a singleton

```bash
centrs retrieve $R /system/resource --attribute uptime --username $U --password $P
```

Envelope: `data` is the bare value, not an object.

### 6. Comma-list --attributes on a list

```bash
centrs retrieve $R /interface --attributes name,type --username $U --password $P
```

Envelope: `data` is an array of objects each containing only `name` and `type`.

### 7. --all-attributes (RouterOS details=true)

```bash
centrs retrieve $R /system/resource --all-attributes --username $U --password $P
```

### 8. Conflict: --attribute + --all-attributes

Rejected before any network call, with `usage/conflicting-flags`.

```bash
centrs retrieve $R /system/resource --attribute uptime --all-attributes --username $U --password $P
```

## --list-attributes

### 9. List attributes for a path

Without running `print`/`get`.

```bash
centrs retrieve $R /system/resource --list-attributes --username $U --password $P
```

Envelope: `data` is `string[]`. No `meta.timing.request` (no transport call).

## Validation surface

### 10. Unknown path

Must fail with `validation/unknown-path` (not `routeros/unsupported-path`
from a server round-trip; the validator catches it first). The error
envelope must include suggested alternatives from `/console/inspect` when
available.

```bash
centrs retrieve $R /not/a/real/path --username $U --password $P
```

### 11. Unknown attribute

`validation/unknown-attribute` with suggestions.

```bash
centrs retrieve $R /system/resource --attribute bogus --username $U --password $P
```

## Transport / error contract

### 12. Bad credentials

`transport/auth-failed`, `details_url` populated.

```bash
centrs retrieve $R /system/resource --username wrong --password wrong
```

### 13. Unreachable host

`transport/connection-refused` (not the more general `transport/network`).

```bash
centrs retrieve 198.51.100.1:7080 /system/resource --username $U --password $P
```

### 14. REST timeout ceiling

`--timeout 70000` against `--via rest-api` is rejected up front with
`usage/timeout-out-of-range` (REST hard cap is 60s).

```bash
centrs retrieve $R /system/resource --via rest-api --timeout 70000 --username $U --password $P
```

## CDB resolution (once wired)

### 15. Name resolution

`<router>` is a CDB-stored name; user/password are filled from CDB.

```bash
centrs retrieve MyChrInCdb /system/resource
```

### 16. Unused --cdb-password on an unencrypted CDB

Call succeeds with a `cdb/password-not-needed` warning in `meta.warnings`.

```bash
centrs retrieve MyChrInCdb /system/resource --cdb-password ignored
```

## Format

### 17. --format yaml

`--format json` is the default for non-tty; `--format yaml` renders the same
envelope. The two outputs round-trip to the same JS value.

```bash
centrs retrieve $R /system/resource --format yaml --username $U --password $P
```

## Out-of-scope (must surface as not-implemented)

### 18. --query

Returns `validation/not-implemented` immediately.

```bash
centrs retrieve $R /ip/address --query 'address~"192"' --username $U --password $P
```

### 19. --filter

Same handling as `--query`.

```bash
centrs retrieve $R /ip/address --filter 'disabled=no' --username $U --password $P
```
