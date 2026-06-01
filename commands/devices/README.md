# devices

List, inspect, and edit RouterOS targets known to centrs. `devices` is the
user-facing surface over the device registry described in
`docs/CONSTITUTION.md`. It is the only command that may *write* to the CDB.

Status: `CHR-passed`. The read subset (`list`/`show`/`groups`) and the full CDB
mutation surface (`add`/`edit`/`set`/`remove`), ambiguity / `--match`, and the
provenance/override examples are green via `bun run test:integration`
(`test/integration/devices.test.ts`, fixture-backed — `devices` does no network
IO, so its evidence is the integration run, not a booted CHR). Encrypted-CDB
**writes** remain blocked (`cdb/encrypted-write-unverified`); encrypted **reads**
work with `--cdb-password`. See `docs/MATRIX.md` for the matrix row.

`devices` does not use a transport in the protocol sense and does not contact a
RouterOS device in phase 1. Its sources are:

- explicit CLI input,
- environment variables (`CENTRS_*`),
- the CDB at `~/.config/tikoci/winbox.cdb` (override with `--cdb-file`),
- local ARP cache for MAC → IP resolution when explicitly enabled,
- (later) the MNDP cache and `dude.db` import via `tikoci/donny`.

## Identity model

The CDB record's `target` field IS the identity — the literal you type at the
CLI. It is one of:

- an IPv4 address (`192.0.2.5`, optionally `host:port`),
- an IPv6 address (`2001:db8::5`, optionally `[2001:db8::5]:port`),
- a MAC (`AA:BB:CC:DD:EE:FF`, case-insensitive, separators normalized),
- a DNS name (`edge1.lan`).

The comment is *not* a lookup key. To make `edge1` resolvable, the CDB entry's
target must be `edge1` (or `edge1.lan`). The comment carries free text plus an
optional centrs **kv-soup** of option overrides — see below.

When the CLI target is a literal IP / IPv6 / MAC that matches an entry's
target exactly, credentials and other CDB-resident fields are loaded from that
entry. If no entry matches, the call still proceeds but `--username` /
`--password` (or `CENTRS_USERNAME` / `CENTRS_PASSWORD`) become mandatory.

### Ambiguity

If a typed target matches more than one entry (e.g. one IPv4 + one IPv6
entry that share a DNS name in `target`, or two entries with the same MAC):

- **TTY:** centrs prompts interactively, listing the matches and asking which
  to use.
- **Non-TTY:** centrs errors with `identity/ambiguous`. The error envelope
  lists all matching entries (by `cdbRecordIndex` and `target`). The caller
  can re-run with `--match=<exact-target>` to pin the choice.

`--prefer-family=ipv4|ipv6` is a non-interactive way to break v4/v6 ties
deterministically; with it set, no prompt is raised. It emits a warning
when it actually selected between candidates.

## Comment kv-soup (per-device overrides)

The CDB `comment` field is free text. centrs additionally parses tokens
shaped like `key=value` out of it and treats them as per-device defaults for
its own settings. Recognized keys (allowlist):

| Key        | Effect                                                                  |
| ---------- | ----------------------------------------------------------------------- |
| `via`      | Default transport for this device (`rest-api`, `native-api`, `ssh`, …). |
| `validate` | `true` / `false`. `false` is the escape hatch; CLI overrides.           |
| `timeout`  | Default request timeout in ms. Per-transport caps still apply.          |
| `port`     | Non-default transport port. Omitted when equal to the protocol default. |
| `ssh-key`  | Per-device private key file path for SSH transports.                    |
| `source`   | Provenance marker for discovered/imported records (`mndp`, `dude`, …).  |
| `mcp`      | MCP write policy for this device: `ro` (default) or `rw`. See `commands/mcp/`. |

Rules:

- First-class CDB fields (`user`, `password`, `group`, `profile`, `session`)
  must **not** appear in the kv-soup — they already have CDB tags. centrs
  refuses to write them via `devices set`.
- `ssh-key` stores a path only, never private key material. Key contents belong
  in the user's filesystem / SSH agent and are always treated as sensitive if an
  error needs to mention them.
- Unknown keys → `cdb/unknown-option` warning. The call still succeeds.
- Tokens are shell-word tokenized. Values with spaces require double quotes
  (`"…"`), with `\"` and `\\` escapes. `=` inside a quoted value is literal.
- `commentMirror` is kept in sync with `comment` on every write.

Precedence (lowest → highest): built-in defaults → project config →
comment-kv → env (`CENTRS_*`) → CLI flag / API arg. `meta.settings` reports
the winner and source per setting.

## Groups

Groups are CDB-native: each entry's `group` field is a single string. There
is no group-definition record. A group is the set of all entries whose
`group` value matches by exact, case-sensitive string compare. An entry with
`group=""` belongs to no group.

`--group <G>` on any command resolves to the membership set and fans out.
`discover --save --timeout 60s` writes MNDP records with `group=discovered`
unless the caller supplies another group.

## Fanout (multi-target invocations)

Any command may receive multiple positional targets, one or more `--group`
flags, or both. The resolved member set is de-duplicated by CDB record index.

- Each member runs in parallel up to `--concurrency` (default
  `max(1, floor(os.cpus().length / 2))`).
- `--fail-fast` aborts pending members on the first failure.
- The outer envelope's `data` is an array of inner envelopes, one per member,
  in the resolved member order (CDB record index — see `devices` group
  expansion), not completion order, so repeated runs produce stable diffs.
  Members still execute in parallel and may *complete* out of order; progress
  is surfaced via `meta`, but the `data` array is always reassembled in the
  deterministic resolved order. `ok` of the outer envelope is `true` iff every
  inner envelope is `ok: true`.
- Commands that are not safe to fan out (e.g. `terminal`) reject N > 1 with
  `usage/fanout-not-supported`.

## Subcommands

```text
centrs devices list [--group G] [--format json|yaml|text]
centrs devices show <target> [--explain]
centrs devices groups [--members]
centrs devices add <target> [--user U] [--password P] [--group G]
                             [--profile P] [--session S] [--comment "text k=v"]
                             [--record-type ipAdmin|ipUser|macTarget|...]
centrs devices edit <target>
centrs devices set  <target> k=v [k=v ...]   # comment kv-soup overrides only
centrs devices remove <target>
```

- `list` shows resolved targets, their record type, group, and a one-line
  provenance summary. No network IO.
- `show` returns a single resolved target with the full per-field source map
  in `meta.target`. `--explain` adds the raw CDB record dump under
  `data.record`.
- `groups` lists distinct non-empty group strings with member counts.
  `--members` expands to the full membership per group.
- `add` modifies first-class CDB fields and prompts before overwriting an
  existing target unless `--force` is passed (`add` against an existing target
  without `--force` errors `cdb/already-exists`).
- `edit` is the TUI/wizard form for changing first-class CDB fields.
- `set` modifies only the comment kv-soup. Refuses to set keys that map to
  first-class CDB fields. Refuses unknown keys when `--strict`.
- `remove` removes a single entry. Group-wide deletes (`--group G`) require
  `--force` (writes are large).

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

Refusals:

- Writing to an encrypted CDB is **blocked** with
  `cdb/encrypted-write-unverified`. Encrypted-CDB writes are not yet verified
  to round-trip byte-identically through WinBox, and a bad write would corrupt
  the file. Make the edit in WinBox until a manual round-trip is verified;
  *reading* encrypted CDBs stays supported.
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

`devices` is `CHR-passed` for reads (open and encrypted CDBs) and for writes to
**unencrypted** CDBs. The comment-kv grammar is settled — see "Comment kv-soup"
above and `test/unit/comment-kv.test.ts`. These remain open:

| Question | Affects | Notes |
| --- | --- | --- |
| ARP resolver test scheme | retrieve / execute when target is a MAC | Need deterministic fixtures per OS plus one live same-L2 proof before relying on ARP in integration. |
| WinBox compatibility after salt rotation | encrypted-CDB writes | Encrypted writes stay blocked (`cdb/encrypted-write-unverified`) until a manual round-trip ("open in WinBox after a centrs write") plus the salt-rotation fixture test (centrs write → centrs read → bytes-identical-modulo-salt) both pass. |

When a row is answered, fold it into this README and delete the row.

## Residual risks

- **Encrypted-CDB writes are blocked, not implemented.** Until a manual
  "WinBox can still open this file" round-trip is verified, every mutation
  against an encrypted CDB fails fast with `cdb/encrypted-write-unverified`.
  Reads are unaffected. Re-enabling encrypted writes needs the salt-rotation
  fixture test (centrs write → centrs read → bytes-identical-modulo-salt) plus
  the manual WinBox verification.
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
