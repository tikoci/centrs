# settings — examples

Each numbered example is an executable spec, in the same style as
`commands/devices/examples.md`. `settings` performs no network IO, so its
integration tests run against a fixture `centrs.env` rather than a live CHR.

`$SETTINGS_DIR` is a per-test temporary directory passed as `XDG_CONFIG_HOME`
for the invocation, so the resolved file is `$SETTINGS_DIR/tikoci/centrs.env`
— there is no checked-in fixture file; each test starts from either an absent
file or one written in-test. This mirrors `$CDB` in the `devices` fixtures.
Some examples also reference `$CDB` (a fixture WinBox CDB, built the same way
as `devices`' fixtures) to exercise the `__default__` boundary between the two
files.

Every example below is a named test in `test/integration/settings.test.ts`
("example N: ..."), green via `bun run test:integration:settings`.

## print

### 1. Print with no file present

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings print
```

No `centrs.env` exists yet. `data` lists every settings-managed key with
`source: { kind: "default", key: <attr> }`. For `format`, since the built-in
default varies per command, `data.format = { value: null, source: { kind:
"default", key: "format" }, perCommandDefault: { retrieve: "text", execute:
"text", transfer: "text", api: "json" } }` instead of a single scalar.

### 2. Print after a value is set

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set format json
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings print
```

`data.format = { value: "json", source: { kind: "config", key:
"CENTRS_FORMAT" } }`. No `perCommandDefault` block once an override exists —
the file's value applies uniformly.

### 3. Print --all surfaces unrecognized lines

The fixture file has a hand-added `# my note` comment and a
`CENTRS_QUUX=5s` line (not a real key) before any `set` call in this test.

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings print --all
```

`data` includes an `unrecognized` array: `[{ key: "CENTRS_QUUX", value:
"5s" }]`, tagged `(unrecognized)`. Bare `print` (no `--all`) from the same
fixture omits it entirely — it isn't a key `settings` knows, managed or
refused.

### 4. Print a single attribute

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings print max-results
```

`data` contains only the `max-results` entry, not the full set.

### 5. Real env overrides the file

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR CENTRS_FORMAT=yaml centrs settings print format
```

The file (from example 2) holds `CENTRS_FORMAT=json`, but the real process
environment wins per precedence: `data.format = { value: "yaml", source: {
kind: "env", key: "CENTRS_FORMAT" } }`.

### 6. Print under --skip-env-file still shows the file

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings print --skip-env-file
```

`ok: true`. Values and sources are unchanged from example 2 — `settings`
itself always reads the real file. `meta.warnings` includes a note that
`--skip-env-file` is active and other commands run in this same environment
would not see these values.

## get

### 7. Get a key with no override and a per-command default

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings get format
```

Fresh file. `data.value = null`, `data.source = { kind: "default", key:
"format" }`, `data.perCommandDefault` populated as in example 1 above. This
is `get`'s one deliberate exception to "returns one value" — there truly
isn't one until an override exists.

### 8. Get after set returns the resolved value

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set max-results 250
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings get max-results
```

`data = { value: 250, source: { kind: "config", key: "CENTRS_MAX_RESULTS" } }`.

### 9. Get an unknown key

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings get totally-bogus-key
```

Errors `settings/unknown-key` — the token isn't a recognized `CENTRS_*`-shaped
name at all (not a typo close enough to suggest, not a plausible env name).
`details_url` populated.

### 10. Get a credential-shaped key redacts the value

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR CENTRS_CDB_PASSWORD=hunter2 centrs settings get cdb-password
```

`ok: true` — read-only inspection is allowed even for refused-on-write keys
(see README Scope boundary). `data = { value: "(redacted)", isSet: true,
source: { kind: "env", key: "CENTRS_CDB_PASSWORD" } }`. The literal secret
`hunter2` must not appear anywhere in the envelope, including
`meta`/`error.context` on any code path — this example exists specifically to
pin that.

### 11. Get a key that also has a per-device comment-kv form

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set via ssh
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings get via
```

`ok: true`. `data = { value: "ssh", source: { kind: "config", key:
"CENTRS_VIA" } }` — fully validated and managed like any other key (see
README: there is no second-class "unmanaged" tier). `tips` (the envelope's
existing informational channel, not `warnings`) carries a
`tip/comment-kv-may-override` entry noting that a device's own `via=`
comment-kv override, if set, takes precedence over this global default —
since `settings` has no target/device context here, it cannot say whether
any specific device actually has one.

## set

### 12. Set a known key (happy path)

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set format json
```

`ok: true`. `data = { key: "format", previous: null, value: "json" }`. Reading
the file directly shows a single `CENTRS_FORMAT=json` line.

### 13. Prefix and case are normalized on input, canonical on write

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set CENTRS_MAX_RESULTS 250
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set max-results 250
```

Both calls resolve to the same key and produce the identical
`CENTRS_MAX_RESULTS=250` line — the second call is a no-op mutation (file
unchanged, `data.previous == data.value == 250`, still `ok: true`).

### 14. Set an invalid value for a typed key

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set format xml
```

Errors `settings/invalid-format` (the shared `{text, json, yaml}` union — see
README). No file mutation; a failed `set` never partially writes.

### 15. First write creates the directory and file

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR/does-not-exist-yet centrs settings set format text
```

`ok: true`. `$SETTINGS_DIR/does-not-exist-yet/tikoci/` is created, along with
`centrs.env` inside it.

### 16. Set preserves unrelated file content

Fixture file (written in-test, not via `settings`) contains:

```env
# personal note, keep me
CENTRS_VIA=ssh
CENTRS_FORMAT=text
```

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set format json
```

Re-reading the file shows the comment and the `CENTRS_VIA=ssh` line
byte-for-byte unchanged; only the `CENTRS_FORMAT` line's value changed to
`json`. (`via` is a fully managed key too — this example is about `set` only
touching the one line it was asked to touch, not about `via` being
second-class.)

### 17. Set a refused credential key

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set cdb-password hunter2
```

Errors `settings/reserved-key`. `remediation` points at `--cdb-password` /
`CENTRS_CDB_PASSWORD` / `Bun.secret()`. No file mutation — re-reading the
file (or a fresh `print`) shows no `CENTRS_CDB_PASSWORD` line was written.
The literal value `hunter2` does not appear anywhere in the error envelope.

### 18. Set a comment-kv-shadowed key is a normal validated write

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set validate false
```

`ok: true`. `data = { key: "validate", previous: null, value: false }`. No
warning — `validate` is validated with the same `parseBoolean` rule as any
other boolean key; the fact that a device's own `validate=` comment-kv can
override it per-device is normal precedence layering, not a reason to treat
this write differently from `set format json`.

### 19. Set an unrecognized key name

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set totally-bogus-key value
```

Errors `settings/unknown-key`, same as `get` (example 9). No file mutation.

### 20. Set a typed integer key out of range

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set max-results 0
```

Errors `settings/invalid-integer` (positive-integer rule, matching
`resolveOptionalIntegerSetting`'s existing validation used elsewhere). `-1`
and non-numeric input (`abc`) behave the same.

### 21. Set an invalid protocol identifier

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set via carrier-pigeon
```

Errors `settings/invalid-via` — same enum and code `retrieve.ts` already uses
for `--via`/`CENTRS_VIA` (`rest-api`, `native-api`, `ssh`, `snmp`, `mndp`,
`mac-telnet`, `romon`, `winbox-terminal`). No file mutation.

### 22. Set an invalid duration

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set timeout not-a-duration
```

Errors `settings/invalid-timeout` (`parseDuration` rules: bare milliseconds
or a `ms`/`s`/`m` suffix). No file mutation.

### 23. Boolean values are written in canonical 1/0 form

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set mcp-allow-adhoc true
```

`ok: true`. Reading the file directly shows `CENTRS_MCP_ALLOW_ADHOC=1`, not
`=true` — `settings` accepted the `parseBoolean`-recognized spelling `true`
as input but always writes the canonical `1`/`0` (see README: this is
required because `src/mcp/config.ts` checks the literal string `"1"`, not the
shared boolean parser). `settings get mcp-allow-adhoc` afterward returns
`{ value: true, source: { kind: "config", ... } }` — `get` still returns a
real boolean, only the on-disk serialization is canonicalized.

### 24. A value that will fail later still gets a warning now

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set transfer-via ftp
```

`ok: true` — `ftp` is a recognized `CENTRS_TRANSFER_VIA` value syntactically,
so `set` writes it. `meta.warnings` contains a note that `transfer` will
currently reject `ftp` at call time unless `ALLOW_UNSAFE_PROTOCOLS` includes
it (`settings/unsafe-protocol-blocked`, `src/transfer.ts`) — `settings` warns
rather than silently accepting a value it knows will not work, without
duplicating `transfer`'s own runtime gate.

### 25. Re-setting the same value is idempotent

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set format json
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set format json
```

Both calls return `ok: true`; the second reports `data.previous ==
data.value`. The file has exactly one `CENTRS_FORMAT=` line afterward, not
two.

## reset

### 26. Reset removes the line, not just its value

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings set format json
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings reset format
```

`ok: true`. The `CENTRS_FORMAT=` line is **absent** from the file afterward —
not present with an empty value (see README: an empty value would be
"set to empty string" for a bash-sourced file, not "unset"). A follow-up
`settings get format` shows `source: { kind: "default" }` again, matching
example 7.

### 27. Reset on a key that was never set is a no-op success

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings reset max-results
```

Fresh file, `CENTRS_MAX_RESULTS` never written. `ok: true`,
`data.wasSet: false` — resetting nothing is not an error.

### 28. Reset with no attribute clears every managed key, leaves the rest

Fixture file:

```env
# keep me
SOME_OTHER_VAR=untouched
CENTRS_FORMAT=json
CENTRS_MAX_RESULTS=250
CENTRS_VIA=ssh
```

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings reset
```

`ok: true`. `data.cleared = ["format", "max-results", "via"]` — all three
recognized keys, `via` included, since it's fully managed like the others.
Re-reading the file shows the comment and `SOME_OTHER_VAR=untouched`
unchanged; the three managed lines are gone. No confirmation was required
(see README: local-file blast radius, always recoverable via `set`).

### 29. Reset also refuses credential keys

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings reset cdb-password
```

Errors `settings/reserved-key`, same family as `set` (example 17) — `reset`
is a mutating verb and refuses the same key list.

## Interactive / non-TTY

### 30. Bare `settings` under non-TTY behaves like `print`

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings </dev/null
```

`ok: true`, identical shape to `settings print` (example 1/2 depending on
fixture state). No prompt is emitted and the call does not hang.

The interactive TTY flow (clack-style prompts collecting `__default__`
credentials and confirming preferences) is explicitly deferred — see the
README's "later slice" note and its `@clack/prompts` dependency prerequisite.
It has no example here because a genuine TTY session isn't exercisable in the
fixture-backed integration tier (the same reason `devices` has no interactive
example either, only the `</dev/null` disambiguation case). When that slice
ships, its examples land as a new numbered range appended here, not inserted
into the middle of this list.

## `__default__` boundary

### 31. Print reports `__default__` presence without leaking secrets

Fixture CDB `$CDB` has a `__default__` record with `user=admin` and a
password set.

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings print --cdb-file $CDB
```

`ok: true`. `data.defaultDevice = { configured: true, user: "admin",
passwordSet: true }` — the password value itself never appears. This is the
one place `settings print` reaches into the CDB rather than `centrs.env`;
`--cdb-file` here is a probe-only flag (see README Surface), not a settings
precedence source. It's read-only (no CDB mutation), matching the README's
"the `__default__` record only" boundary.

### 32. Print with no `__default__` record

```bash
XDG_CONFIG_HOME=$SETTINGS_DIR centrs settings print --cdb-file /tmp/does-not-exist.cdb
```

`ok: true` (a missing/absent CDB is not an error for `settings`, unlike
`devices list` in devices' example 3 — `settings` degrades to "no default
device configured" rather than `cdb/not-found`, since reporting settings
should not require a CDB to exist at all). `data.defaultDevice = {
configured: false }`.
