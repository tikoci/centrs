# devices

List, inspect, and edit RouterOS targets known to centrs. `devices` is the
user-facing surface over the device registry described in
`docs/CONSTITUTION.md`. It is the only command that may *write* to the CDB.

Status: `CHR-passed` for the surface described by `examples.md`. The read subset
(`list`/`show`/`groups`) and the CDB mutation surface (`add`/`set`/
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
`CENTRS_PASSWORD`, or a `__default__` record) become mandatory. The one
exception is a **pinned** CDB (`--cdb-file`, `CENTRS_CDB_FILE`,
`CENTRS_CDB_PASSWORD`, or a `centrs.env` CDB path) with no `__default__`
record: a DNS name or identity that matches nothing fails closed with
`cdb/not-found-target`, because it can't be told apart from a mistyped record.
An address that matches nothing still proceeds as a literal host: an IPv4 or
IPv6 literal (optionally with a port, IPv6 as `[…]:port`), an `http(s)://` URL,
or a MAC. On MCP every target must still be registered
(`cdb/target-not-registered`).

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
  `--match` takes the same selector on `devices show`/`set`/`remove` and on
  every command that resolves a `<router>` from the CDB: `retrieve`,
  `execute`, `api`, `transfer`, `terminal` and `btest client` (#583). It is a
  single-target flag: with a fan-out selection or `--quickchr` it is
  `usage/conflicting-flags`, and when no CDB record is in play (no CDB, an
  unregistered literal host, a `__default__`-only fallback, or `--host`
  without `<router>`) it fails `identity/no-match` rather than being ignored.
  With no target at all (no `<router>`, no `--host`) the CLI still reports
  the missing-target usage error first.
  An ambiguous positional inside a fan-out names the single-target
  `--match` re-run, since the fan-out itself refuses the flag.

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
| `port`          | override | Legacy all-transport port (REST, native API, SSH, MAC-Telnet delivery). Prefer the per-service keys below. Omitted when equal to the protocol default. |
| `www-port`, `www-ssl-port` | override | REST port, plain/TLS. Beats `port`. See "Per-service ports". |
| `api-port`, `api-ssl-port` | override | Native API port, plain/TLS. Beats `port`. |
| `ssh-port`      | override | SSH port (execute, terminal, SFTP transfer). Beats `port`. |
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
- **Per-service ports** are named after RouterOS `/ip/service` entries. Only
  the transport that connects to that service reads them; MAC-Telnet reads
  none. Within the CDB tier the matching key beats `port=`; `--port`,
  `CENTRS_PORT` and the rest of the ladder are unchanged, so a CLI/env port still
  wins (config `CENTRS_PORT` stays below the CDB). Plain vs TLS: an explicit
  `http://`/`https://` in the target picks that variant and is never switched;
  with no scheme the stored variant decides, secure first when both are stored.
  A saved key decides TLS by its name, so `api-port=8729` is plain. A higher-tier
  `--port` replaces only the number and keeps the saved variant's TLS, except
  native's existing explicit 8728 (plain) / 8729 (TLS) rule. An invalid value
  warns `cdb/invalid-option` and counts as absent. `meta.settings.port` names
  the key that won (e.g. `record:3:www-ssl-port`).
- Unknown keys → `cdb/unknown-option` warning. The call still succeeds.
- Tokens are shell-word tokenized. Values with spaces require double quotes
  (`"…"`), with `\"` and `\\` escapes. `=` inside a quoted value is literal.
- An **empty value removes** the token: `devices set <t> via=` deletes the `via`
  override (matching the internal upsert/remove model in `comment-kv.ts`). There
  is no current need to store a literally-empty value; revisit if one arises.
  Removing a token that is already absent is a no-op success — the comment is
  left byte-for-byte identical.
- First-class fields have their own empty-value rules, distinct from token
  removal: `--password ""` clears the stored password (and its saved-password
  flag); `--user ""` writes an empty user. Bare `user=` / `password=` /
  `group=` / `profile=` / `session=` positionals never reach those fields —
  they are refused with `cdb/reserved-key` — so comment-token removal (`key=`
  deletes the token) and credential clearing (`--password ""` empties the
  password) are deliberately different operations.
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
digits, optional dotted fraction); hex (`0x10`), scientific (`1e2`), and values
that overflow to `Infinity` are rejected with `input/invalid-coordinate` /
`input/invalid-altitude` even though `Number()` would accept them, because the
fields are decimal degrees / meters.

GPS validation (range, strict-decimal, pairing, `altitude-type` enum) applies to
the **setter flags** (`--lat`/`--lon`/`--altitude`/`--gps`) and to **bare `k=v`
update tokens** (`lat=…`, `lon=…`). It does **not** re-parse arbitrary base
`--comment` text: `devices add <t> --comment "lat=91"` is a freeform escape hatch
that stores the comment as-is (such a value simply won't resolve to a `location`
on read). Use the flags or `k=v` tokens when you want validated GPS.

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

`--group <G>` on a router-facing fan-out command resolves to the membership set.
`discover --save` writes MNDP records with `group=discovered`
unless the caller supplies another group.

### Promotion (discovered → managed)

There is no `promote` verb. Moving one device out of `group=discovered` and
giving it credentials uses `set` on that target:

```bash
centrs devices set <target> --group prod --user admin --password …
```

On `devices add`/`set`, `--group` writes the first-class group field; on
`devices list` it filters. Bulk `set`/`remove` selection and a separate
`--new-group` flag remain designed, not implemented. Both mutations currently
require one target, with `--match` to disambiguate saved records.

## Fanout (multi-target invocations)

Router-facing fan-out commands may receive multiple positional targets, one or more `--group`
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
- Commands that are not safe to fan out (`terminal`, and `api --stream` or a
  `/listen` endpoint) reject a multi-target selection with `usage/fanout-not-supported`.

## Subcommands

```text
centrs devices init [--encrypt]         # create an empty CDB at the resolved path
centrs devices encrypt [--no-backup]    # explicitly encrypt an existing open CDB
centrs devices list [--group G] [--where attr=value]
                    [--near lat,lon,radius] [--bbox south,west,north,east]
                    [--format json|yaml|text]
centrs devices show <target> [--explain] [--via <protocol>] [--match <selector>]
                    [--show-password]
centrs devices groups [--members]
centrs devices discover [--timeout 15s] [--group G]      # designed, not implemented; use `centrs discover --save`
centrs devices add <target> [--user U] [--password P|--password-stdin] [--group G]
                             [--profile P|--profile-none|--profile-own]
                             [--session S] [--comment "text k=v"]
                             [--record-type ipAdmin|ipUser|macTarget|...]
                             [--gps lat,lon[,altitude[,altitude-type]]]
                             [--lat D] [--lon D] [--altitude M] [--altitude-type MSL|AGL]
                             [--show-password]
centrs devices set  <target> [--match <selector>] [--user U] [--password P|--password-stdin] [--group G]
                             [--profile P|--profile-none|--profile-own]
                             [--session S] [k=v ...]
                             [--gps lat,lon[,altitude[,altitude-type]]]
                             [--lat D] [--lon D] [--altitude M] [--altitude-type MSL|AGL]
                             [--show-password]
centrs devices remove <target> [--match <selector>]
centrs devices edit <target>            # future: clack/TUI wizard
```

`add` and `set` are deliberately symmetric: both take the same first-class
flags and the same `k=v` comment tokens. The only difference is existence —
`add` creates (and refuses an existing target), `set` modifies (and refuses a
missing target). `edit` is reserved for a future interactive wizard (the
clack-style prompt used by `@tikoci/quickchr`); it is **not** a separate
field-editing verb, and invoking it today returns `usage/not-implemented`. There
is no `update`.

- `init` creates an empty CDB (open by default, encrypted with `--encrypt`)
  at the resolved path (`--cdb-file`,
  `CENTRS_CDB_FILE`, or the default), with parent directories and mode `0600`.
  It never overwrites: on an existing, readable CDB matching the encryption
  requirement it succeeds with a
  `cdb/file-exists` warning and writes nothing. An explicit path is created only
  by `init`; every other subcommand reports `cdb/not-found` for it (typo
  protection), and that error names `init`.
- `list` (alias `print`) shows resolved targets, their record type, group, and
  a one-line provenance summary. Each row carries the `identity=`/`mac=`/`ip=`
  lookup keys it resolves by (when set), so one call maps names to records. No
  network IO. `--where attr=value`
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
- `set` modifies one matched record. First-class fields change via flags
  (`--user`, `--password`, `--group`, `--profile[-none|-own]`, `--session`);
  comment lookup/override keys change via `k=v` positionals. The positional
  target and optional `--match` select the record. Against a missing target
  it errors `cdb/not-found-target`. Writing
  a first-class field name as a `k=v` positional (e.g. `user=x`) stays refused
  with `cdb/reserved-key` — the flag is the only path. Unknown comment keys warn
  (`cdb/unknown-option`), or error under `--strict`. Deleting an unknown key
  (`key=`) is always allowed, including under `--strict`.
- `remove` (aliases `rm`, `delete`) removes one matched entry. The positional
  target and optional `--match` select the record; group-wide deletion is not
  implemented.

### Record password channels

`add` and `set` take the record password one of two ways:

- `--password <secret>` — argv. Simple, but `ps` can show the value while the
  process runs, and shell history can keep the command after it exits.
- `--password-stdin` — read from stdin, so the value never appears in argv. For
  automation and harnesses that spawn centrs (`printf '%s' "$PW" | centrs
  devices set <t> --password-stdin`, or `centrs devices set <t>
  --password-stdin < pw.txt`).

`--password-stdin` rules:

- Exactly one trailing newline (`\n` or `\r\n`) is stripped, so `echo pw |`
  works. Any other whitespace is part of the password.
- The rest must be valid UTF-8 with no leading byte-order mark; otherwise it
  is `input/invalid-stdin`. The CDB stores record strings as UTF-8 and drops a
  leading BOM on read, so either would store a different credential than the
  bytes piped in.
- Empty input (nothing, or only that one newline) is `input/empty-stdin`.
  Clearing a stored password stays a deliberate `--password ""`, never an empty
  pipe.
- A terminal on stdin is refused with `usage/stdin-is-tty`; centrs does not
  prompt.
- `--password` together with `--password-stdin` is `usage/conflicting-flags`.
  There is no precedence order between them.
- Only `add` and `set` accept it; every other subcommand refuses it with
  `input/invalid-command`.
- The value is never echoed in errors. Success envelopes are the same as with
  `--password`.

There is no environment-variable channel for the record password:
`CENTRS_PASSWORD` is the dial credential, not a CDB field.

### Record password in output

`show`, `add` and `set` withhold the stored record password by default, in text
and JSON (#551). Each entry always carries `passwordSet: boolean` (true when a
non-empty password is stored); text prints `password: (set, hidden)` or
`(not set)`. `--show-password` returns the cleartext `password` on those three
subcommands; every other subcommand refuses it with `input/invalid-command`.
The `--explain` record's password field reads `<redacted>` without the flag.
When an unknown-tcode `rawTail` comes before any decoded password field, the
tail may hold the password, so without the flag its `value` reads
`<redacted: N bytes, may contain password>` instead of the bytes. Such a
record decodes to an empty password, so `passwordSet` is `false` (it reports
the password centrs decoded and would dial with); the `cdb/unknown-field`
warning then carries `context.mayContainPassword: true`.
There is no encryption gate: the opt-in works the same on an open or encrypted
CDB. `passwordSet` is not the WinBox `savedPassword` ("keep password") flag.

The library matches the CLI: exported `showDevice` / `addDevice` / `setDevice`
redact by default and take `showPassword?: boolean` (default `false`); with
`showPassword: true` the entry type is `DevicesShowItemWithPassword`. MCP
(`centrs_devices`) never passes it, so MCP output never carries the password.

Dialing does not read this envelope. The resolver and the MCP allowlist gate
read the raw record through an internal lookup (`lookupDeviceRecord`, not
exported from the package root), so a CDB-credentialed dial still sends the
stored password. The public entry type has no `password` field, so a caller
that reached for the envelope instead fails to type-check.

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

## CDB encryption lifecycle (#558)

Start encrypted with `devices init --encrypt`, or start open for a lab and run
`devices encrypt` when moving to production. Both require a non-empty
`--cdb-password` / `CENTRS_CDB_PASSWORD`. A password alone does not change the
mode of initialization or ordinary writes. The library exports
`initCdb({ encrypt: true, cdbPassword, cdbFile })` and
`encryptCdb({ cdbPassword, cdbFile })`; both use the shared settings precedence.

Encrypted initialization keeps atomic no-clobber creation and mode `0600`.
Initialization returns `data.encrypted` for both newly created and existing
files. Competing encrypted initializers with different passwords fail closed:
the loser gets `cdb/decrypt-failed` when it cannot unlock the winner's file.
An existing open CDB refuses `init --encrypt`; conversion must be explicit.
An existing encrypted CDB is verified with the supplied password and left alone.
Conversion requires an existing readable CDB, preserves its records and unknown
fields, uses a fresh salt and atomic replacement, and keeps its file mode.
`data` reports `cdbFile`, `encrypted: true`, `changed`, `recordCount`, and the
new `backupPath` when conversion occurred. Default text output reports
`encrypted` or `verified encrypted ... (unchanged)`, the record count, and
the backup path when created, followed by the plaintext-backup warning.
Already-encrypted conversion verifies
the password and returns `changed: false` without rewriting or rotating it.

**Backups remain sensitive.** Conversion retains every existing backup and
creates a plaintext snapshot of the original; it does not run backup retention.
The `cdb/plaintext-backups` warning accompanies conversion, including no-op runs:
only the active file is protected. Handle backups according to your own retention
policy; centrs neither encrypts nor deletes them during conversion. Subsequent
ordinary writes still use the normal two-backup retention below.
`--no-backup` (library: `skipBackup: true`) skips the new plaintext snapshot, so
no fresh plaintext copy is written; earlier backups are still retained and the
warning still applies to them. Without the snapshot, a forgotten password cannot
be recovered.

`init` and `encrypt` act on the CDB file, not on records: they accept only
`--cdb-file`, `--cdb-password`, `--format`/`--json`, plus `--encrypt` (`init`)
or `--no-backup` (`encrypt`). Any other flag is `input/invalid-command`
instead of being silently ignored. `devices init --help` and
`devices encrypt --help` show only those accepted flags; the same metadata
generates their sections in [`docs/CLI.md`](../../docs/CLI.md).

Close WinBox before conversion. If it shares this path, it must reopen it using
the CDB password; WinBox does not take the centrs lock, so a running WinBox can
save its in-memory list over the conversion. Concurrent centrs writers are safe:
conversion takes the CDB lock and refuses a stale snapshot with `cdb/conflict`
(see "Concurrent writers" below). Password rotation and decryption are outside this slice. WinBox manual
interoperability verification remains open (see Residual risks).

## CDB write strategy

Revision-checked writes use one helper (`writeWinBoxCdb`) under the CDB lock
(see "Concurrent writers" below):

1. Re-reads the file and refuses with `cdb/conflict` if it changed since the
   caller loaded it.
2. Snapshots the current file to `winbox.cdb.bak.<timestamp>` beside it (the
   timestamp is a filesystem-safe, lexicographically-sortable ISO variant; a
   second backup in the same millisecond gets a `-1`, `-2`, … suffix instead of
   overwriting the first).
3. Keeps the last 2 backups, deletes older ones. The lock, not backups, guards
   against concurrent writers; backups are an undo for a mistaken mutation.
4. Builds the new record set with unknown fields preserved verbatim (see
   below).
5. Writes to `winbox.cdb.tmp.<pid>.<rand>` in the same directory and `fsync`s
   it (then best-effort `fsync`s the directory).
6. `rename()`s over the original (atomic on POSIX), so a crash never leaves a
   partially-written CDB. On Windows, where replacing a file another process
   has open (antivirus, the search indexer, WinBox) fails transiently, the
   rename is retried briefly on `EPERM`/`EACCES`/`EBUSY` before the error
   surfaces.

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

### Concurrent writers (#581)

Atomic rename alone does not protect read–modify–write: two callers that load
the same CDB and both save would each get success while the second silently
dropped the first's change. centrs closes that gap with a revision check inside
a lock.

- **Revision.** `loadCdb()` records `LoadedCdb.revision`, the sha256 of the
  on-disk bytes (`absent` when there was no file). An encrypted CDB gets a fresh
  salt per write, so every write changes its revision.
- **Lock.** A write takes the sibling lock file `<cdb>.lock` (for example
  `winbox.cdb.lock`). The lock appears atomically with its holder record (pid,
  hostname, start time, token): it is written to a temp file and hard-linked
  into place, which never replaces an existing lock. Waiting is bounded (10 s),
  then `cdb/locked` names the lock file and holder. Reads never lock.
  If the filesystem explicitly reports that hard links are unsupported, the
  write fails with `cdb/lock-unsupported`; move the CDB to a filesystem that
  supports them. Permission errors are not classified as missing support.
- **Check under the lock.** Holding the lock, the writer re-reads the file and
  compares revisions; a mismatch is `cdb/conflict` and nothing is written (no
  backup either). Check and replacement are one critical section.
- **Replay.** CLI and MCP `add`/`set`/`remove`, and `discover --save`, reload and replay a
  conflicted mutation (up to 5 attempts in total, `CDB_CONFLICT_MAX_ATTEMPTS`).
  Replay re-runs normal validation, so a racing duplicate `add` becomes
  `cdb/already-exists` rather than an overwrite. Library callers holding an old
  `LoadedCdb` receive `cdb/conflict` and choose; `retryOnCdbConflict()` is the
  same helper the CLI uses. `devices encrypt` does not replay automatically;
  retry the command after a conflict.
- **Leftover locks.** A lock whose holder recorded this host and whose pid is no
  longer running is removed automatically. A lock from another host (a CDB on a
  shared drive), an unreadable lock, or a pid the OS reused is never removed by
  age; delete it by hand once no centrs writer is running. Windows recycles pids
  quickly, so this is the more likely case there.
  Recovery attempts are serialized by a SQLite write transaction on the
  persistent `<cdb>.lock.guard` file. The OS releases that mutex if a breaker
  crashes. The guard stores no CDB data and must stay in place: deleting it
  while writers are running could let two recovery attempts overlap.
- **Low-level writes.** `writeWinBoxCdb()` without `expectedRevision` stays an
  unsynchronized primitive for callers that own the file exclusively. Every
  centrs mutation passes it.

**Boundary: writers outside centrs.** WinBox and other tools do not take the
lock. The revision check catches their writes made before centrs' locked check,
not one landing between the check and the rename, and it cannot stop a running
WinBox from later saving its in-memory address list over the file. This matters
only when WinBox is pointed at the same file centrs uses. Close WinBox before
mutating that file with centrs.

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
