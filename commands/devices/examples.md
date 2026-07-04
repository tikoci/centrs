# devices — examples

Each numbered example is an executable spec. `devices` performs no network
IO, so its integration tests run against a fixture CDB rather than a live
CHR. The fixtures are built in-test from the known CDB primitives and written
into a temporary directory at runtime (open and encrypted, encrypted password
`centrs-test`); there are no checked-in `.cdb` files. See
`test/integration/devices.test.ts`.

Writes operate on a copy of the fixture per test; the source bytes are never
mutated in place. `$CDB` is the per-test path.

> The decided `devices` redesign is fully implemented and exercised below:
> lookup-key resolution (`identity=`/`mac=`/`ip=`, examples 32–34), the broadened
> `--match` selectors (`user=`/`target=`, examples 6/35/36), the symmetric
> `add`/`set` model (`edit` reserved for the interactive editor, example 37), the
> `(target, user)` record identity (example 36), the `--profile-none`/
> `--profile-own` sentinels (example 38), the `tips[]` channel (example 40), and
> the CLI verb aliases (example 41). The `__default__` fallback record is
> resolver-level (unit-tested in `test/unit/resolver.test.ts`). Do not reconcile
> the README back to these examples; reconcile forward.

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

### 11. Add the same (target, user) without --force

Record identity is `(target, user)`, so a collision requires the **same user**
(`192.0.2.5` is saved under `admin`).

```bash
centrs devices add 192.0.2.5 --user admin --password other --cdb-file $CDB
```

Errors with `cdb/already-exists`. No file mutation. No backup written.

### 12. Replace the same (target, user) with --force

```bash
centrs devices add 192.0.2.5 --user admin --password new --force --cdb-file $CDB
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

## set (first-class fields)

`set` modifies an existing record. First-class fields change via flags; comment
override/lookup keys change via `k=v` positionals (next section). `add` takes the
same flags + positionals — the only difference is existence (`add` creates,
`set` requires the record to exist).

### 15. Set credentials (first-class fields)

```bash
centrs devices set 192.0.2.5 --user admin2 --password new --cdb-file $CDB
```

`ok: true`. Other fields (group, profile, comment, unknowns) unchanged.

### 16. Set a missing target

```bash
centrs devices set 203.0.113.1 --user x --password y --cdb-file $CDB
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

`discover --save` writes CDB records that `devices list` surfaces
with `group="discovered"` and `source=mndp` in comment-kv metadata.

```bash
centrs devices list --cdb-file $CDB --group discovered
```

`ok: true`; each member reports CDB provenance and discovery metadata.

## Lookup-key resolution

`<router>` resolves against the `target` field **and** the `identity=` / `mac=` /
`ip=` comment lookup keys (see `README.md`, Identity model). MAC values compare
case- and separator-insensitively. These run against a dedicated lookup fixture
(`$CDB_LOOKUP`): one `ipAdmin` record `192.0.2.60` with
`comment="identity=edge1 mac=AA:BB:CC:DD:EE:11"`, and one `macTarget` record
`AA:BB:CC:DD:EE:22` with `comment="identity=edge2 ip=192.0.2.61"`.

### 32. Resolve by the identity= lookup key

```bash
centrs devices show edge1 --cdb-file $CDB_LOOKUP
```

`ok: true`. The resolved entry's `target` is `192.0.2.60`;
`meta.target.identity` is `edge1`.

### 33. Resolve by the mac= lookup key (case/separator-insensitive)

```bash
centrs devices show aa-bb-cc-dd-ee-11 --cdb-file $CDB_LOOKUP
```

`ok: true`. Resolves the same `192.0.2.60` record even though the typed MAC uses
dashes and lower case.

### 34. Resolve by the ip= lookup key

```bash
centrs devices show 192.0.2.61 --cdb-file $CDB_LOOKUP
```

`ok: true`. Resolves the `AA:BB:CC:DD:EE:22` record; `meta.target.identity` is
`edge2`.

### 35. A duplicated identity= is ambiguous; --match user= pins it

A second fixture (`$CDB_DUP_IDENTITY`) holds two distinct hosts that share
`identity=dup` (the deliberately non-unique identity case).

```bash
centrs devices show dup --cdb-file $CDB_DUP_IDENTITY </dev/null
```

`identity/ambiguous`; `error.context.matches` lists both records (with `user`).

```bash
centrs devices show dup --match user=ops --cdb-file $CDB_DUP_IDENTITY
```

`ok: true`; selects the `ops` record. `--match target=<addr>` and
`--match <record-type>` are the other selectors.

## (target, user) identity

### 36. The same address under a different user coexists

`192.0.2.5` is saved under `admin`. Adding it under a different user is a new
record, not a collision.

```bash
centrs devices add 192.0.2.5 --user ops --password ops-pw --cdb-file $CDB
```

`ok: true`, `data.replaced: false`. The CDB now holds two records for
`192.0.2.5`, so the bare address is ambiguous:

```bash
centrs devices show 192.0.2.5 --cdb-file $CDB </dev/null
```

`identity/ambiguous`. `centrs devices show 192.0.2.5 --match user=ops` resolves
the new record; `--match user=admin` the original.

## edit (reserved for the interactive editor)

### 37. `edit` reports usage/not-implemented

```bash
centrs devices edit 192.0.2.5 --cdb-file $CDB
```

Errors with `usage/not-implemented`. The interactive (clack/TUI) editor is not
built yet; use `set` for non-interactive field and metadata changes.

## Profile sentinels

### 38. Write the `<none>` / `<own>` profile sentinels

```bash
centrs devices set 192.0.2.5 --profile-none --cdb-file $CDB
```

`ok: true`; the record's `profile` becomes `<none>`. `--profile-own` writes
`<own>`; `--profile <name>` writes a named profile. The three are mutually
exclusive (passing more than one is a usage error).

## Symmetric add (fields + k=v)

### 39. Add with bare k=v positionals

```bash
centrs devices add 198.51.100.30 --user admin --password p \
  identity=spare via=ssh --cdb-file $CDB
```

`ok: true`. The record's comment carries `identity=spare via=ssh`, so the device
is then resolvable as `spare`. A first-class field written as a positional
(`user=x`) is refused with `cdb/reserved-key` — use the `--user` flag.

## Tips

Tips are advice, not anomalies (see `docs/CONSTITUTION.md`, Result envelope).
They ride the top-level `tips[]` channel, always present (`[]` when empty),
and render in text mode under a `Tips:` footer.

### 40. An empty registry suggests adding a device

```bash
centrs devices list --cdb-file $EMPTY_CDB
```

`ok: true`, `data: []`, and `tips` carries a `tip/no-devices` entry (with a
`fix`). `--json` includes the same `tips[]` array. `devices show` on a record
with no stored password emits `tip/credentials-missing` unless a `__default__`
record supplies fallback creds.

## Verb aliases

The RouterOS-muscle-memory aliases (`commands/AGENTS.md`, Verb vocabulary)
resolve silently to the canonical verb: `print`→`list`, `get`→`show`,
`rm`/`delete`→`remove`. Canonical names still win in help text and the usage
line; aliases are a CLI input affordance only (the MCP `op` enum and the API
functions stay canonical-only).

### 41. Aliases resolve to the canonical verb

```bash
centrs devices print --cdb-file $CDB                 # = list
centrs devices get 192.0.2.5 --cdb-file $CDB         # = show
centrs devices rm 192.0.2.5 --cdb-file $CDB          # = remove
centrs devices delete 192.0.2.5 --cdb-file $CDB      # = remove
```

Each alias produces the same envelope as its canonical verb — `meta.operation`
reports the canonical command (`list`/`show`/`remove`), never the alias. An
unknown verb still errors with `input/invalid-command`, and the error lists the
canonical verbs plus the accepted aliases.

## Location / GPS

Slice 1 of issue #146: `lat`/`lon`/`altitude`/`altitude-type` are recognized
comment-kv facts (see `README.md`, Location / GPS) — stored, queryable via
`--where`, and returned as a `location` block in `devices show`/`list` output.
Coordinate order is **lat-first everywhere**: `--gps <lat>,<lon>[,…]`.

### 42. `add --gps` sets lat/lon/altitude; `show` returns a `location` block

```bash
centrs devices add 198.51.100.40 --user admin --password p \
  --gps 37.7749,-122.4194,16 --cdb-file $CDB
```

`ok: true`. Re-reading via `show` returns
`data.entry.location = { lat: 37.7749, lon: -122.4194, altitude: 16, altitudeType: "MSL" }`
(the 3-part `--gps` form defaults the missing altitude-type to `MSL`).

### 43. Discrete `--lat`/`--lon` round-trip the same way as `--gps`

```bash
centrs devices set 192.0.2.5 --lat 51.5072 --lon -0.1276 --cdb-file $CDB
```

`ok: true`. `devices show 192.0.2.5` returns
`data.entry.location = { lat: 51.5072, lon: -0.1276 }` (no `altitude` key —
altitude was never set on this record).

### 44. `--altitude` alone defaults `altitudeType` to `MSL` in the envelope

```bash
centrs devices set 192.0.2.6 --lat 48.8566 --lon 2.3522 --altitude 35 \
  --cdb-file $CDB
```

`ok: true`. `altitude-type` was never written to the comment (only
`--altitude` was passed), but `devices show 192.0.2.6` still returns
`data.entry.location.altitudeType = "MSL"` — the metadata-only default applied
at read time (`deviceLocation` in `src/resolver/geo.ts`).

### 45. Setting `lat` without `lon` errors with `input/incomplete-gps`

```bash
centrs devices set 198.51.100.1 --lat 10 --cdb-file $CDB
```

Errors with `input/incomplete-gps` (target `198.51.100.1` carries no prior
`lon`). No write; no backup written.

### 46. An out-of-range `--lat` errors with `input/invalid-coordinate`

```bash
centrs devices set 192.0.2.5 --lat 200 --lon 0 --cdb-file $CDB
```

Errors with `input/invalid-coordinate`. No write; no backup written.

### 47. An invalid `--altitude-type` errors with `input/invalid-altitude`

```bash
centrs devices set 192.0.2.5 --lat 10 --lon 10 --altitude-type wgs84 \
  --cdb-file $CDB
```

Errors with `input/invalid-altitude`. No write; no backup written.

### 48. Alias flags canonicalize to the stored key; no more `cdb/unknown-option`

```bash
centrs devices set 192.0.2.5 --latitude 10 --lng 20 --cdb-file $CDB
```

`ok: true`, **no** `cdb/unknown-option` warning — `--latitude`/`--lng` are
canonicalized to `lat`/`lon` in one place (`canonicalizeGeoKey`,
`src/resolver/geo.ts`) before storage. `devices show 192.0.2.5` returns
`data.entry.comment` containing `lat=10` and `lon=20` (the canonical keys), and
`data.entry.location = { lat: 10, lon: 20 }`.

### 49. `list --where lat=<verbatim>` matches the exact stored string

```bash
centrs devices list --where lat=37.774900 --cdb-file $CDB
```

`ok: true`; matches only the record whose stored `lat` fact is the exact
string `37.774900` (values are stored verbatim as typed, never reformatted —
see `README.md`, Location / GPS). `--where lat=37.7749` (numerically equal,
reformatted) matches nothing.

## Geo query (`list --near` / `list --bbox`)

`--near`/`--bbox` filter `devices list` by device GPS (great-circle radius or a
lat-first bounding box). Coordinates are lat-first everywhere (see `README.md`,
Location / GPS); a geo-less device carries no location and is silently excluded.
The same predicates ride the shared fan-out grammar on every non-terminal
command (`execute`/`retrieve`/`api`/`transfer`) — see `docs/CONSTITUTION.md`
(Target selection).

### 50. `list --near <lat>,<lon>,<radius>` selects in-radius devices

`192.0.2.5` is in San Francisco and `192.0.2.6` in New York (set via `--gps`);
the other records carry no GPS.

```bash
centrs devices list --near 37.7749,-122.4194,50km --cdb-file $CDB
```

`ok: true`; `data` holds only `192.0.2.5`. New York is ~4100 km away (outside the
50 km radius) and the geo-less records never match. The radius unit is one of
`m`/`km`/`mi`/`ft`; a bare number is kilometers.

### 51. `list --bbox <south>,<west>,<north>,<east>` selects devices in the box

```bash
centrs devices list --bbox 37.70,-122.52,37.83,-122.35 --cdb-file $CDB
```

`ok: true`; `data` holds only the device whose GPS falls inside the lat-first
box (edges inclusive). The box must satisfy `south <= north` and `west <= east`
(no antimeridian wrap), else `input/invalid-bbox`.

### 52. `--near`/`--bbox` are `list`-only

```bash
centrs devices set 192.0.2.5 --near 37.7749,-122.4194,50km --cdb-file $CDB
```

Errors with `input/invalid-command`: `--where`/`--near`/`--bbox` *select*
records for `list`; `add`/`set` name the `<target>` directly. Store GPS with
`--gps`/`--lat`/`--lon` instead.

### 53. An unrelated `set` on a record with a lone `lat` does not fail

The lat/lon pairing check fires only when the write actually touches a
coordinate. A record that already carries a lone `lat` (e.g. a hand-edited or
imported comment) can still take unrelated updates.

```bash
centrs devices add 203.0.113.7 --user u --password p \
  --comment "lat=37.7749" --cdb-file $CDB
centrs devices set 203.0.113.7 timeout=5000 --cdb-file $CDB
```

Both succeed: the `add` stores the freeform comment verbatim, and the later
`set timeout=5000` does **not** raise `input/incomplete-gps` even though the
record's GPS pair is incomplete. Touching `lat`/`lon` (e.g. `set lat=…`) would
re-enable the pairing check.
