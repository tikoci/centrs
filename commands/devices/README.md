# devices

List, inspect, and edit RouterOS targets known to centrs. `devices` is the
user-facing surface over the device registry described in
`docs/CONSTITUTION.md`. It is the only command that may *write* to the CDB.

Status: `CHR-passed` for the surface described by `examples.md`. The read subset
(`list`/`show`/`groups`) and the CDB mutation surface (`add`/`edit`/`set`/
`remove`), ambiguity / `--match`, and the provenance/override examples are green
via `bun run test:integration` (`test/integration/devices.test.ts`,
fixture-backed — `devices` does no network IO, so its evidence is the
integration run, not a booted CHR). Encrypted-CDB **writes** round-trip through
decrypt → mutate → re-encrypt under the loaded password; encrypted **reads**
work with `--cdb-password`. See `docs/MATRIX.md` for the matrix row.

The redesign this README describes is now implemented: the `identity`/`mac`/`ip`
comment lookup keys and broadened `--match` selectors (`user=`/`target=`), the
`identity` field rename (was `name`), the symmetric `add`/`set` model (`edit`
reserved for a future interactive editor), the `(target, user)` record identity,
the `--profile-none`/`--profile-own` sentinels, the `__default__` fallback
record, and the top-level `tips[]` channel are all live (examples 10–16, 32–40;
`__default__` is resolver-level, unit-tested in `test/unit/resolver.test.ts`).
Treat this README as the spec, `docs/MATRIX.md` as the implemented status.

`devices` does not use a transport in the protocol sense and does not contact a
RouterOS device in phase 1. Its sources are:

- explicit CLI input,
- environment variables (`CENTRS_*`),
- the CDB at `~/.config/tikoci/winbox.cdb` (resolved under `$HOME`, not
  `$XDG_CONFIG_HOME`; override with `--cdb-file` / `CENTRS_CDB_FILE`; if
  encrypted, decrypt with `--cdb-password` / `CENTRS_CDB_PASSWORD`, or
  `Bun.secret()` on the CLI when that lands),
- local ARP cache for MAC → IP resolution when explicitly enabled,
- (later) the MNDP cache and `dude.db` import via `tikoci/donny`.

## Identity model

The CDB record's natural identity is the **(target, user)** pair, matching
WinBox: saving the same address under a different user creates a second record,
not an update. The `target` is the connectable literal WinBox/REST/native use,
and is one of:

- an IPv4 address (`192.0.2.5`, optionally `host:port`),
- an IPv6 address (`2001:db8::5`, optionally `[2001:db8::5]:port`),
- a MAC (`AA:BB:CC:DD:EE:FF`, case-insensitive, separators normalized),
- a DNS name (`edge1.lan`).

WinBox has no separate "name" field, so a human handle is overlaid in the
comment as **lookup keys** (constitution: identity and CDB). centrs resolves
`<router>` against the `target` field **and** these comment-kv keys:

| Lookup key  | Meaning                                                                 |
| ----------- | ---------------------------------------------------------------------- |
| `identity=` | The device `/system/identity`. Human handle; deliberately may repeat. |
| `mac=`      | A MAC, when `target` is an IP/DNS name rather than the MAC.            |
| `ip=`       | An IP, when `target` is an identity/DNS name rather than the IP.       |

Whichever identifiers are not the `target` ride the comment as lookup keys, so
one record is resolvable by identity **or** IP **or** MAC **or** DNS-name
regardless of which is stored as `target`. These three keys are the *only*
sanctioned exception to "the comment is free text"; every other token stays
inert. (Earlier drafts said "the comment is not a lookup key" — superseded.)

When `<router>` matches an entry (by `target` or a lookup key), credentials and
other CDB-resident fields load from that entry. If nothing matches, the call
still proceeds but `--username` / `--password` (or `CENTRS_USERNAME` /
`CENTRS_PASSWORD`, or a `__default__` record) become mandatory.

### Ambiguity

Because identity is `(target, user)`, one address legitimately maps to several
records — the same host saved under two users, or `ipAdmin` + `ipUser` for one
host. That is not an error in itself; it only becomes ambiguous when `<router>`
alone cannot pick one (the caller named an address that several records share,
or a duplicated `identity=`):

- **TTY:** centrs prompts interactively, listing the matches and asking which
  to use.
- **Non-TTY:** centrs errors with `identity/ambiguous`. The error envelope
  lists all matching entries (by `cdbRecordIndex`, `target`, `user`, and
  `recordType`). The caller pins the choice with `--match` by `user`
  (`--match user=admin`), by record-type (`--match ipUser`), or by exact target.

`--prefer-family=ipv4|ipv6` is a non-interactive way to break v4/v6 ties
deterministically; with it set, no prompt is raised. It emits a warning
when it actually selected between candidates.

## Comment kv-soup (per-device overrides)

The CDB `comment` field is free text. centrs additionally parses tokens
shaped like `key=value` out of it. Recognized keys (allowlist) fall in three
groups: **lookup keys** affect how `<router>` resolves (see "Identity model");
**override keys** are per-device defaults for centrs settings; **geo keys**
(issue #146) are facts, not settings — queryable via `--where` and returned in
the `location` block (see "Location / GPS" below), but never coerced into
resolver settings.

| Key             | Group    | Effect                                                                  |
| --------------- | -------- | ---------------------------------------------------------------------- |
| `identity`      | lookup   | Device `/system/identity`; a resolvable handle. May repeat across records. |
| `mac`           | lookup   | A MAC, when `target` is not the MAC.                                    |
| `ip`            | lookup   | An IP, when `target` is not the IP.                                     |
| `via`           | override | Default transport for this device (`rest-api`, `native-api`, `ssh`, …). |
| `validate`      | override | `true` / `false`. `false` is the escape hatch; CLI overrides.           |
| `timeout`       | override | Default request timeout in ms. Per-transport caps still apply.          |
| `port`          | override | Non-default transport port. Omitted when equal to the protocol default. |
| `ssh-key`       | override | Per-device private key file path for SSH transports.                    |
| `source`        | override | Provenance marker for discovered/imported records (`mndp`, `dude`, …).  |
| `mcp`           | override | MCP write policy for this device: `ro` (default) or `rw`. See `commands/mcp/`. |
| `lat`           | geo      | Latitude, decimal degrees (`-90..90`). See "Location / GPS".            |
| `lon`           | geo      | Longitude, decimal degrees (`-180..180`). Paired with `lat`.             |
| `altitude`      | geo      | Meters, may be negative. Metadata-only (not a fan-out query predicate). |
| `altitude-type` | geo      | `MSL`\|`AGL` (default `MSL`). Normalized to upper case for storage.     |

Rules:

- First-class CDB fields (`user`, `password`, `group`, `profile`, `session`)
  must **not** appear in the kv-soup — they already have CDB tags. This has two
  distinct outcomes by path: a reserved token found while *parsing* an existing
  comment is inert and only warns `cdb/reserved-option` (centrs won't act on it,
  but won't reject a hand-written comment); explicitly passing one as a `devices
  set` positional (`user=x`) is a hard `cdb/reserved-key` error, because you are
  asking centrs to *write* it — use the dedicated flag (`--user`) instead.
- `ssh-key` stores a path only, never private key material. Key contents belong
  in the user's filesystem / SSH agent and are always treated as sensitive if an
  error needs to mention them. It joins the comment-kv allowlist *with* the SSH
  transport (see `commands/terminal/README.md`), not before — a key path with no
  working SSH transport is the kind of half-feature we avoid.
- Unknown keys → `cdb/unknown-option` warning. The call still succeeds.
- Tokens are shell-word tokenized. Values with spaces require double quotes
  (`"…"`), with `\"` and `\\` escapes. `=` inside a quoted value is literal.
- An **empty value removes** the token: `devices set <t> via=` deletes the `via`
  override (matching the internal upsert/remove model in `comment-kv.ts`). There
  is no current need to store a literally-empty value; revisit if one arises.
- `commentMirror` is kept in sync with `comment` on every write.

Precedence (lowest → highest): built-in defaults → user config file
(`centrs.env`) → comment-kv → env (`CENTRS_*`) → CLI flag / API arg.
`meta.settings` reports the winner and source per setting.

### Derived facts (queryable, may be stale)

Beyond lookup keys and setting overrides, a record may carry **derived facts**
learned from a probe — `board`, `version`, `software-id` (from MNDP or `check`),
plus an `updated=<iso>` stamp marking when they were last refreshed. These are
*facts, not settings*: they are queryable/selectable (e.g. `--where board=RB5009`
to fan a command across a device class) but must **never override a live read**,
and they can go stale. `devices add`/`set --check` and `check --fix` refresh them
from a live device; `discover --save` seeds them. `software-id` is a
**verification** key
("is this still the same box?"), not a resolution key (you don't type it to reach
a device); `license-id` is convenience metadata to match by hand against
MikroTik's CHR licensing page. The `--where` selector plus this derived-fact
allowlist are the planned home for "operate on a class of devices," distinct from
`group`. (Promoting these keys to the comment-kv allowlist is a tracked code
follow-up; `lat`/`lon`/`altitude`/`altitude-type` — see "Location / GPS" below —
are the first keys promoted this way, issue #146.)

## Location / GPS

Per-device GPS (issue #146) is a **fact, not a setting**: recognized
(`devices set lat=…` no longer warns `cdb/unknown-option`), stored, queryable via
`--where` (exact) and `--near`/`--bbox` (geo), and returned as a `location` block
in `devices show`/`list` output — but never coerced into resolver settings. This
section covers storage/flags/validation/envelope; the geo query predicates are in
"Geo query" below.

### Storage keys

See the comment-kv table above for `lat`/`lon`/`altitude`/`altitude-type`.
Values are stored **verbatim as typed** (validated, not reformatted), so an
exact `--where lat=<value>` still matches what was written — `altitude-type` is
the one exception, since it's a closed two-value enum, so it is normalized to
upper case (`msl` -> `MSL`) before storage. `lat`/`lon` must be written as a
pair: setting one without the other, when the other is not already on the
record, errors `input/incomplete-gps`. Only the pairing rule fires per-write —
an unrelated `set timeout=…` on a record that already carries a lone `lat` is
left untouched.

`lat`/`lon`/`altitude` accept **strict decimal** only (optional leading `-`,
digits, optional dotted fraction); hex (`0x10`) and scientific (`1e2`) notation
are rejected with `input/invalid-coordinate` / `input/invalid-altitude` even
though `Number()` would accept them, because the fields are decimal degrees /
meters.

### Flags

`devices add`/`set` accept:

- `--lat <deg>` (alias `--latitude`)
- `--lon <deg>` (aliases `--lng`, `--longitude`, `--long`)
- `--altitude <meters>` (aliases `--alt`, `--ele`, `--elevation`) — `altitude`
  stays the canonical field (the ISO 6709 / EPSG / IETF `geo:` / W3C-Geolocation
  term); `ele`/`elevation` are GPX-muscle-memory aliases, not a rename
- `--altitude-type <MSL|AGL>` (alias `--alt-type`), case-insensitive
- `--gps <lat>,<lon>[,<altitude>[,<altitude-type>]]` — combined convenience;
  minimum `--gps <lat>,<lon>`; a missing altitude-type in the 3-part form
  defaults to `MSL`.

Bare `k=v` positionals also work (`lat=…`, `lon=…`, `altitude=…`,
`altitude-type=…`), through the same validation as the flags above. Aliases are
canonicalized to their table form in one place before storage/validation, so
the canonical key is always what lands in the comment and the envelope; typos
beyond the alias list are caught by the existing "Did you mean?" flag
suggester (`closestFlags`/`unknownFlagError`).

Validation errors reuse the `input/` arg-validation family:
`input/invalid-coordinate` (lat/lon NaN or out of range),
`input/invalid-altitude` (altitude NaN, or a bad altitude-type), and
`input/incomplete-gps` (lat/lon not paired, or `--gps` wrong arity).

### Coordinate order is lat-first

`--gps 37.7749,-122.4194` is `lat,lon` — **latitude first, everywhere** —
matching ISO 6709 / EPSG:4326 authority order (and Google Maps / Leaflet /
most GPS devices), not GeoJSON's lon-first order. RFC 7946 (GeoJSON) describes
its own order as the opposite of "most GPS coordinates" and calls swapping them
"the most common GeoJSON bug"; lat-first is both what an agent guesses from the
`--gps` name and the standards-backed (ISO 6709) choice. A future GeoJSON
(lon-first) input path is deliberately out of scope here — it would ride a
structurally-typed shape (a real GeoJSON object / TikTOML import), never a bare
CSV.

### Altitude is metadata-only

`altitude`/`altitude-type` are stored and returned in `devices show`/`list`
output, but are **not** part of any fan-out query predicate — the `--near`/
`--bbox` geo selectors are 2-D lat/lon only.

### Geo query (`--near` / `--bbox`)

Two geo selectors filter/select by device GPS. On `devices list` they filter the
listing; on every non-terminal fan-out command (`execute`/`retrieve`/`api`/
`transfer`) they are union selector terms in the shared target-selection grammar
(`docs/CONSTITUTION.md`, Target selection). Coordinates are lat-first (above); a
geo-less device carries no location and is silently excluded (never an error).

- `--near <lat>,<lon>,<radius>` — devices within a great-circle (haversine)
  radius of the point. `radius` takes a unit suffix `m`/`km`/`mi`/`ft`
  (case-insensitive); a bare number is kilometers. A malformed/negative radius is
  `input/invalid-radius`; wrong arity is `input/invalid-command`.
- `--bbox <south>,<west>,<north>,<east>` — devices inside the axis-aligned box
  (`minLat,minLon,maxLat,maxLon`, edges inclusive). Requires `south <= north` and
  `west <= east` (an antimeridian-crossing box is not supported in v1), else
  `input/invalid-bbox`.

On `devices list`, `--group`/`--where`/`--near`/`--bbox` AND-narrow the listing
(a filter surface); `--near` and `--bbox` union with each other. In the fan-out
grammar every selector unions (see the constitution). `--near`/`--bbox` are
rejected on `add`/`set`/`show`/`remove` with `input/invalid-command` — they
select, they do not store.

### Envelope

`devices show`/`list` add an optional `location` block to each entry that
carries a well-formed `lat`+`lon` pair, parsed from the comment facts:

```json
{ "lat": 37.7749, "lon": -122.4194, "altitude": 16, "altitudeType": "MSL" }
```

A record with no (or malformed) `lat`/`lon` simply omits `location`.

### Group-level GPS defers to #137

CDB groups are a bare string field on each entry — there is no
group-definition record to hang a group-level GPS or lat/lon inheritance on.
That needs TikTOML (#137); not doable in the CDB today.

## Groups

Groups are CDB-native: each entry's `group` field is a single string. There
is no group-definition record. A group is the set of all entries whose
`group` value matches by exact, case-sensitive string compare. An entry with
`group=""` belongs to no group.

`--group <G>` on any command resolves to the membership set and fans out.
`discover --save` writes MNDP records with `group=discovered`
unless the caller supplies another group.

### Promotion (discovered → managed)

There is no `promote` verb. Moving one device out of `group=discovered` and
giving it credentials is `devices set <t> --new-group prod --user … --password
…`. A **bulk** promotion (a whole discovered class at once) is the same call with
a target selector picking the records:

```bash
devices set --group discovered --new-group prod \
  --user admin --password … --force
```

`--group` (and `--where`/`--all`/positionals) always **selects** which records to
modify; `--new-group` always **writes** the group field. The two are distinct
flags, so there is no select-vs-set overload — this resolves the former wrinkle.
(Code follow-up: the CLI still overloads `--group` as the `add`/`set` field
setter today; `examples.md` reflects that current flag until the `--new-group`
split lands.)

## Fanout (multi-target invocations)

Any command may receive multiple positional targets, one or more `--group`
flags, `--all`, `--default`, `--where <attr>=<value>` (device-class), and/or the
geo selectors `--near <lat>,<lon>,<radius>` / `--bbox <south>,<west>,<north>,<east>`
(see "Geo query" above) — see `docs/CONSTITUTION.md` (Target selection grammar).
The resolved member set is
de-duplicated by CDB record index (ad-hoc literal targets by host), and members
are reassembled in record-index order regardless of completion order, so repeated
runs produce stable diffs.

- Each member runs in parallel up to `--concurrency` (transport-aware defaults:
  `rest-api` 8, `native-api` 4).
- Output is the locked `FanoutData` envelope with the granular `0`/`2`/`1` exit
  code. The envelope shape (outer `ok` = orchestration success; a per-target
  failure is an inner `ok: false`) and the exit-code contract are defined once in
  [`docs/CONSTITUTION.md`](../../docs/CONSTITUTION.md) (Target selection) — not
  restated here.
- A multi-target **write** is gated by `--yes`, confirmed once up front (not per
  target); without it the error/tip names the blast radius (how many routers).
  `--force` stays scoped to destructive `devices` CDB mutations.
- Commands that are not safe to fan out (`terminal`, and `api --stream` /
  `--listen`) reject a multi-target selection with `usage/fanout-not-supported`.

## Subcommands

```text
centrs devices list [--group G] [--where attr=value]
                    [--near lat,lon,radius] [--bbox south,west,north,east]
                    [--format json|yaml|text]
centrs devices show <target> [--explain] [--via <protocol>] [--match <type>]
centrs devices groups [--members]
centrs devices discover [--timeout 15s] [--group G]      # = discover --save (save implied)
centrs devices add <target> [--user U] [--password P] [--new-group G]
                             [--profile P|--profile-none|--profile-own]
                             [--session S] [--comment "text k=v"]
                             [--record-type ipAdmin|ipUser|macTarget|...]
                             [--gps lat,lon[,altitude[,altitude-type]]]
                             [--lat D] [--lon D] [--altitude M] [--altitude-type MSL|AGL]
centrs devices set  <selector…> [--user U] [--password P] [--new-group G]
                             [--profile P|--profile-none|--profile-own]
                             [--session S] [k=v ...]
                             [--gps lat,lon[,altitude[,altitude-type]]]
                             [--lat D] [--lon D] [--altitude M] [--altitude-type MSL|AGL]
centrs devices remove <selector…>
centrs devices edit <target>            # future: clack/TUI wizard
```

`add` and `set` are deliberately symmetric: both take the same first-class
flags and the same `k=v` comment tokens. The only difference is existence —
`add` creates (and refuses an existing target), `set` modifies (and refuses a
missing target). `edit` is reserved for a future interactive wizard (the
clack-style prompt used by `@tikoci/quickchr`); it is **not** a separate
field-editing verb, and invoking it today returns `usage/not-implemented`. There
is no `update`.

- `list` (alias `print`) shows resolved targets, their record type, group, and
  a one-line provenance summary. No network IO. `--where attr=value`
  (repeatable, AND-combined) filters by CDB-stored facts/comment-kv plus core
  record fields (`target`/`group`/`identity`/`mac`) — e.g. `--where
  lat=37.7749`. `--near lat,lon,radius` and `--bbox south,west,north,east`
  filter by device GPS (see "Geo query"). All three are `list`-only.
- `show` (alias `get`) returns a single resolved target with the full per-field
  source map in `meta.target`. `--explain` adds the raw CDB record dump under
  `data.record`; `--via <protocol>` reports the protocol that would be selected
  for the target without connecting.
- `groups` lists distinct non-empty group strings with member counts.
  `--members` expands to the full membership per group.
- `discover` runs MNDP discovery with `--save` **implied** (you invoked the
  registry surface, so you mean to populate it) — equivalent to `centrs discover
  --save` with the same `group=discovered` / `source=mndp` provenance. It is the
  natural onboarding step and where centrs steers toward setting fallback
  credentials (`__default__`). See `commands/discover/README.md`. Still routes
  through the atomic write layer below, so `devices` remains the only writer.
- `add` creates a record from first-class flags + comment tokens. Against an
  existing `(target, user)` it errors `cdb/already-exists` unless `--force`
  overwrites; the same `target` under a *different* `--user` is a new record,
  not a collision.
- `set` modifies existing record(s). First-class fields change via flags
  (`--user`, `--password`, `--new-group`, `--profile[-none|-own]`, `--session`);
  comment lookup/override keys change via `k=v` positionals. **Which** records to
  modify is the target selector — positionals, `--group`, `--where`, `--all`
  (constitution: target selection) — so `--group` here *selects* and
  `--new-group` *writes* the group field (no overload). Against a missing target
  it errors `cdb/not-found-target`; a multi-record `set` needs `--force`. Writing
  a first-class field name as a `k=v` positional (e.g. `user=x`) stays refused
  with `cdb/reserved-key` — the flag is the only path. Unknown comment keys warn
  (`cdb/unknown-option`), or error under `--strict`.
- `remove` (aliases `rm`, `delete`) removes a single entry. Group-wide deletes
  (`--group G`) require `--force` (writes are large).

`--profile <name>` sets a named WinBox profile; `--profile-none` /
`--profile-own` write the WinBox sentinels `<none>` / `<own>`. `profile` and
`session` are **preserved for WinBox compatibility only** — centrs round-trips
them and lets you edit them, but never acts on them itself. Unset, `profile`
defaults to `<none>` (or is inherited from the `__default__` record).

Grounding: `profile` is WinBox's "Workspace" (a saved window layout). `<none>`
means start with a clean/empty layout; `<own>` means reuse the last session's
layout *for that router* (per-router, not global). Both are meaningless to
centrs's headless use, which is exactly why they are preserve-only.

## Default device (`__default__`)

A reserved record (`target=__default__`) holds global fallback creds + comment
overrides for any device whose own record leaves them unset. Create/edit it like
any other record (`devices add __default__ --user admin --password …`); WinBox
can edit it too. Precedence is per-field: args → env → device record →
`__default__` → built-in default (constitution: identity and CDB).

- `devices list` shows it; tag it `group=default` for clarity if you like.
- On the CLI/API it can supply creds even for a target with no CDB record. On
  **MCP** it never widens the allowlist — an unregistered target is still
  rejected; `__default__` only fills missing creds for a registered device.

## CDB write strategy

All writes go through one helper (`writeWinBoxCdb`) that:

1. Snapshots the current file to `winbox.cdb.bak.<timestamp>` beside it (the
   timestamp is a filesystem-safe, lexicographically-sortable ISO variant).
2. Keeps the last 5 backups, deletes older ones.
3. Builds the new record set with unknown fields preserved verbatim (see
   below).
4. Writes to `winbox.cdb.tmp.<pid>.<rand>` in the same directory and `fsync`s
   it (then best-effort `fsync`s the directory).
5. `rename()`s over the original (atomic on POSIX), so a crash never leaves a
   partially-written CDB.

Encrypted CDBs: the write layer decrypts on load, mutates the open record set,
then re-encrypts with the same password loaded from settings before the atomic
rename. A fresh salt is rolled on every write; the backup is the verbatim prior
ciphertext.

Refusals:

- Writing to an encrypted CDB without `--cdb-password` /
  `CENTRS_CDB_PASSWORD` still fails earlier at load with
  `cdb/password-required`.
- Writing to an unencrypted CDB with `--cdb-password` succeeds with the
  existing `cdb/password-not-needed` warning. centrs does **not** silently
  upgrade the file to encrypted.

### Unknown CDB fields

The current decoder knows tags 1–4, 6, 8, 9, 11, 12 and a fixed set of tcodes.
WinBox writes additional fields (RoMON IPv6 addresses, future settings) that
must round-trip.

- On read: any field with an unknown tag is kept verbatim on
  `WinBoxCdbRecord.fields`. A field with an unknown tcode is captured as a
  `rawTail` field — its `value` is a `Uint8Array` carrying the remainder of
  the record (its own bytes plus any subsequent fields) verbatim, since the
  decoder cannot know the value length without the schema.
- On write: known fields are re-encoded normally. A `rawTail` field is
  emitted as its header (tag, marker, tcode) followed by `value` as raw
  bytes. This round-trips WinBox-authored records that contain unknown
  tcodes byte-for-byte. `devices add/edit/set/remove` will emit a
  `cdb/unknown-field` warning when it preserves a record that carries
  `rawTail` fields, listing the affected tags.

## Envelope shape (target provenance)

Every centrs envelope (not just `devices show`) carries:

```ts
meta.target = {
  target: "edge1.lan",          // what the user typed, normalized
  resolvedTarget: "edge1.lan",  // what we connect to (post DNS, post --match)
  addressFamily: "ipv4" | "ipv6" | "mac" | "dns",
  mac?: "AA:BB:CC:DD:EE:FF",
  user: "admin",
  group?: "prod-edge",
  via: "rest-api",
  cdbRecordIndex?: 7,           // index into CDB record array, if any
  sources: {
    user: "cdb",
    password: "cdb",
    via: "comment-kv",
    validate: "cli",
    timeout: "default",
    // …per resolved setting
  }
}
```

For fanout calls, each inner envelope carries its own `meta.target`. The
outer envelope's `meta.target` is replaced with `meta.targets` (the resolved
member list and the group(s) that expanded into it).

## Open questions (remaining work beyond the current `CHR-passed`)

`devices` is `CHR-passed` for the currently-implemented reads and writes against
both unencrypted and encrypted CDBs. The comment-kv *grammar* is settled — see
"Comment kv-soup" above and `test/unit/comment-kv.test.ts`. The decided redesign
(lookup keys, identity rename, symmetric `add`/`set`, `(target, user)` identity,
profile sentinels, `__default__`, `tips[]`) is now implemented; what remains:

**Still genuinely open:**

| Question | Affects | Notes |
| --- | --- | --- |
| ARP resolver test scheme | retrieve / execute when target is a MAC | Need deterministic fixtures per OS plus one live same-L2 proof before relying on ARP in integration. |

When an item ships with CHR examples, fold it into the matrix and delete the row.

## Residual risks

- **Encrypted-CDB writes have not been verified against WinBox.** centrs
  decrypts → mutates → re-encrypts with a fresh salt, and the bytes round-trip
  through centrs' own decoder. The "open in WinBox after a centrs write"
  manual proof still needs to happen; until then, treat encrypted writes as
  centrs-only and keep the backup the write layer leaves behind.
- **Unknown-tcode preservation is opaque past the first unknown tcode.** The
  decoder captures one `rawTail` blob; fields that follow the unknown tcode
  inside the same record are kept inside that blob and cannot be surfaced
  one-by-one. Acceptable for round-trip writes (the bytes survive); not
  sufficient if a future cell needs to expose those individual fields.
- **MAC → IP without CDB.** Resolver order is CDB first, then local ARP when
  the caller opts into IP-level access. For `execute`, an unresolved MAC
  defaults to mac-telnet instead. MNDP arrives through `discover --save` and
  records provenance under `group=discovered`; it is not authoritative
  inventory.
- **Comment kv-soup collisions with human prose.** Users may have existing
  comments that contain `=` for non-kv reasons. The parser must require a
  bare-word key with no leading whitespace inside the token and treat
  free-form text outside `key=value` tokens as inert.

## Notes for future cells

- `devices` proper has no transport, but several flags on other commands
  depend on its resolver (`--group`, `--match`, `--prefer-family`,
  multi-target positionals). Those flags ship with their host command, not
  with `devices`.
- `dude.db` import lives in `tikoci/donny` and feeds the resolver via the
  same envelope as the CDB. Provenance source label: `dude`.
- The `centrs check` command will reuse the resolver and add a network probe;
  `devices` itself stays RouterOS-IO-free.

### Missing-target guidance (and the MCP/proxy follow-up)

When a command that takes a `<router>` is called without one, the **CLI** turns
the bare usage error into a registry-aware tip (shared helper
`src/cli/missing-target.ts`): it reads the CDB best-effort and emits either
`tip/select-target` (lists a few saved handles to pass — identity over target) or
`tip/no-devices` (→ `centrs discover --save`) when the registry is empty. The
read is unencrypted-only and the CDB **password never threads into the tip path**,
so an encrypted registry falls back to generic guidance.

This guidance is currently **CLI-shaped on purpose** and is *not* yet wired into
the MCP/proxy frontends — that is deferred spec/review work. Two boundaries
should shape it when it lands, because the registry's role differs per frontend:

- The `tip/*` envelope channel is shared-core, but the specific remediation
  *strings* (`centrs devices list`, `centrs discover --save`) are CLI verbs and
  must **not** be emitted verbatim by MCP/proxy. Each frontend phrases the
  next-step in its own vocabulary.
- On **MCP**, targets come from the **CDB allowlist**, not free-text `<router>`
  (constitution: MCP surface). An unregistered/empty target is
  `cdb/target-not-registered`, and the `centrs://devices` resource already
  enumerates the allowlisted targets — so the MCP equivalent of "what can I
  pass?" is "read the `centrs://devices` resource / register a device first,"
  not "run discover." The **proxy** fronts the same CDB and should mirror the MCP
  framing, not the CLI's `discover --save` nudge.
