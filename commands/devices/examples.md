# devices — examples

Each numbered example is an executable spec. `devices` performs no network
IO, so its integration tests run against a fixture CDB rather than a live
CHR. The fixtures are built in-test from the known CDB primitives and written
into a temporary directory at runtime (open and encrypted, encrypted password
`centrs-test`); there are no checked-in `.cdb` files. See
`test/integration/devices.test.ts`.

Writes operate on a copy of the fixture per test; the source bytes are never
mutated in place. `$CDB` is the per-test path.

> These examples track the **currently implemented** verbs (`edit` edits
> first-class fields; `set` writes comment kv-soup only). `README.md` describes a
> decided redesign (symmetric `add`/`set`, `edit` → future TUI, `identity`/`mac`/
> `ip` lookup keys, `__default__`, `tips[]`) that lands with new examples here —
> do not reconcile the README back to these examples; reconcile forward.

## list

### 1. List all targets

```bash
centrs devices list --cdb-file $CDB
```

Envelope: `ok: true`, `data` is an array of `{ target, recordType, group?,
user, sources }`. No `meta.timing.request`.

### 2. List a single group

```bash
centrs devices list --cdb-file $CDB --group prod-edge
```

`data` contains only members whose `group="prod-edge"`. Empty array is a
valid success.

### 3. List with no CDB present

```bash
centrs devices list --cdb-file /tmp/does-not-exist.cdb
```

Errors with `cdb/not-found`. `details_url` populated.

## show

### 4. Show by exact target

```bash
centrs devices show 192.0.2.5 --cdb-file $CDB
```

`data` is one entry. `meta.target.sources` maps every resolved field to
`cdb` or `default`. `meta.target.cdbRecordIndex` is the entry's index.

### 5. Show ambiguous target (non-TTY)

The CDB holds two entries with the same `target` (`2001:db8::5`) — the same
host saved once as an `ipAdmin` record and once as an `ipUser` record. With no
disambiguator and no interactive prompt available, `show` refuses to guess.

```bash
centrs devices show 2001:db8::5 --cdb-file $CDB </dev/null
```

`identity/ambiguous`. `error.context.matches` is an array of
`{ cdbRecordIndex, target, recordType }`, one per colliding entry.

### 6. Show with --match disambiguation

`--match <record-type>` selects among duplicate targets by record type (one of
the `winBoxCdbRecordType` names: `ipAdmin`, `ipUser`, `macTarget`, …).

```bash
centrs devices show 2001:db8::5 --cdb-file $CDB --match ipUser
```

`ok: true`. The returned entry is the `ipUser` record; `meta.target.resolvedTarget`
is `2001:db8::5`. A `--match` token that names no colliding entry errors with
`identity/no-match`; an unknown record-type token errors with `input/invalid-match`.

### 7. Show --explain dumps raw record

```bash
centrs devices show 192.0.2.5 --cdb-file $CDB --explain
```

`data.record` is the raw `WinBoxCdbRecord` (tag/marker/tcode/value). Useful
for diagnosing unknown-field preservation.

## groups

### 8. List distinct groups with counts

```bash
centrs devices groups --cdb-file $CDB
```

`data` is an array of `{ group: string, members: number }`, sorted by name.

### 9. Groups --members expands to membership

```bash
centrs devices groups --cdb-file $CDB --members
```

`data` is an array of `{ group, members: [{ target, recordType }] }`.

## add

### 10. Add an ipAdmin entry

```bash
centrs devices add 198.51.100.10 --user admin --password secret \
  --group prod-edge --comment "site=NYC via=ssh" --cdb-file $CDB
```

Envelope: `ok: true`. Re-reading the CDB shows the entry. Backup file
`$CDB.bak.<iso8601>` exists.

### 11. Add to existing target without --force

```bash
centrs devices add 192.0.2.5 --user other --password other --cdb-file $CDB
```

Errors with `cdb/already-exists`. No file mutation. No backup written.

### 12. Add to existing target with --force

```bash
centrs devices add 192.0.2.5 --user new --password new --force --cdb-file $CDB
```

`ok: true`. Backup written. The previous entry's unknown fields are
preserved on the replacement record; `meta.warnings` contains a
`cdb/unknown-field` entry listing the preserved tags.

### 13. Add against encrypted CDB without password

```bash
centrs devices add 198.51.100.20 --user u --password p \
  --cdb-file $CDB_ENCRYPTED
```

Errors with `cdb/password-required` (load fails before any mutation).

### 14. Add against encrypted CDB with password

```bash
centrs devices add 198.51.100.20 --user u --password p \
  --cdb-file $CDB_ENCRYPTED --cdb-password centrs-test
```

`ok: true`. The write layer decrypts → mutates → re-encrypts under the same
password with a fresh salt, then atomically renames over the original. The
backup (`.bak.<timestamp>`) is the verbatim prior ciphertext.

## edit

### 15. Edit credentials

```bash
centrs devices edit 192.0.2.5 --user admin2 --password new \
  --cdb-file $CDB
```

`ok: true`. Other fields (group, profile, comment, unknowns) unchanged.

### 16. Edit unknown target

```bash
centrs devices edit 203.0.113.1 --user x --password y --cdb-file $CDB
```

Errors with `cdb/not-found-target`.

## set (comment kv-soup)

### 17. Set a recognized override

```bash
centrs devices set 192.0.2.5 via=ssh validate=false --cdb-file $CDB
```

`ok: true`. Re-running `devices show 192.0.2.5` shows
`meta.target.sources.via = "comment-kv"`.

### 18. Set a key that maps to a first-class CDB field

```bash
centrs devices set 192.0.2.5 user=hacker --cdb-file $CDB
```

Errors with `cdb/reserved-key` listing the forbidden keys
(`user`, `password`, `group`, `profile`, `session`).

### 19. Set unknown key (lenient)

```bash
centrs devices set 192.0.2.5 future=maybe --cdb-file $CDB
```

`ok: true` with `cdb/unknown-option` warning. The token is written to
`comment` verbatim.

### 20. Set unknown key with --strict

```bash
centrs devices set 192.0.2.5 future=maybe --strict --cdb-file $CDB
```

Errors with `cdb/unknown-option`. No write.

### 21. Set value with spaces (quoting)

```bash
centrs devices set 192.0.2.5 'note="rack 7 row B"' --cdb-file $CDB
```

`ok: true`. Re-reading parses the value back as `rack 7 row B` (one token).

## remove

### 22. Remove a single entry

```bash
centrs devices remove 192.0.2.5 --cdb-file $CDB
```

`ok: true`. Backup written. Subsequent `devices show` returns
`cdb/not-found-target`.

### 23. Remove unknown target

```bash
centrs devices remove 203.0.113.99 --cdb-file $CDB
```

`cdb/not-found-target`. No backup written.

## Provenance and overrides

### 24. CLI overrides comment-kv

CDB entry has `via=ssh` in its comment. CLI passes `--via rest-api`.

```bash
centrs devices show 192.0.2.5 --via rest-api --cdb-file $CDB
```

`meta.target.via = "rest-api"`, `meta.target.sources.via = "cli"`.
`meta.warnings` includes `cdb/override-applied`.

### 25. Env overrides comment-kv but loses to CLI

```bash
CENTRS_VIA=native-api centrs devices show 192.0.2.5 \
  --via rest-api --cdb-file $CDB
```

`meta.target.via = "rest-api"`, `meta.target.sources.via = "cli"`.

## Fanout (resolved here, executed by other commands)

`devices` itself doesn't fan out — these tests assert the resolver behavior
that other commands consume.

### 26. Group expansion is deterministic

```bash
centrs devices list --group prod-edge --cdb-file $CDB --format json
```

The order of resolved members matches CDB record order. This deterministic
ordering is canonical across centrs: fanout consumers reassemble their `data`
array in this same resolved order (not completion order) so repeated runs
produce stable diffs.

### 27. Unknown group

```bash
centrs devices list --group does-not-exist --cdb-file $CDB
```

`ok: true`, `data: []`, `meta.warnings` includes `cdb/empty-group`.

### 28. Mixed positional + group dedupe (assertion via `devices show`)

The resolver's de-dupe rule: positional targets that are also group members
appear once. Exercised through a downstream command's test once `retrieve`
gains multi-target support; tracked here so the rule is anchored.

## Encrypted CDB read

### 29. Read encrypted CDB with password

```bash
centrs devices list --cdb-file $CDB_ENCRYPTED --cdb-password centrs-test
```

`ok: true`. `meta.settings.cdbFile.kind = "cli"`,
`meta.settings.cdbPassword.kind = "cli"`.

### 30. Wrong password

```bash
centrs devices list --cdb-file $CDB_ENCRYPTED --cdb-password wrong
```

`cdb/decrypt-failed`. `error.cause` includes the decoder's detected magic
mismatch.

## Discovery provenance

### 31. MNDP-discovered entries are marked as discovered

`discover --save --timeout 60s` writes CDB records that `devices list` surfaces
with `group="discovered"` and `source=mndp` in comment-kv metadata.

```bash
centrs devices list --cdb-file $CDB --group discovered
```

`ok: true`; each member reports CDB provenance and discovery metadata.
