# retrieve

Status: `CHR-passed` over `rest-api` and `native-api`, including multi-target
fan-out (see **Target selection**), `--query` row filters (see **Query**),
`--follow` over `native-api` (see **Follow**) and `--sample` over both (see
**Sample**). `snmp` is `not-started`. Matches `docs/MATRIX.md`.

Read RouterOS state. RouterOS menu reads model `<path>/<verb>` where the verb
is `print`-style (`print`, `get`, and async POST-shaped reads as they're
added). SNMP reads use `retrieve <router> snmp <oid|MIB name>` and resolve
names through a MikroTik MIB cache downloaded from mikrotik.com.

> "POST-shaped reads" are RouterOS menu reads that require a request body
> (e.g. paged or query-driven `print`) and are therefore issued as REST `POST`
> rather than `GET`. centrs identifies them from the command tree and routes
> them accordingly as they're added.

Structured formats return an array of records, or — with `--attribute` — a
value or row of values wrapped in the standard envelope
(`docs/CONSTITUTION.md`). The default `text` format renders data and errors for
humans.

## Synopsis

```text
centrs retrieve <router> <path>[/<shortcut>] [flags]
centrs retrieve <router> snmp <oid|MIB name> [flags]
```

- `<router>` — IP, DNS, MAC, or CDB-resolved name. See constitution: identity.
- `<path>` — RouterOS path beginning with `/`, e.g. `/ip/address`. The verb is
  inferred (`print` for list paths, `get` for singletons like
  `/system/resource`). If the unnamed arg does not start with `/`, it is a
  reserved shortcut — currently none are defined; future examples include
  `defconf` → `/system/default-configuration/get`.
- Reading one row by name is **flag-only** (there is no row positional):
  `--query name=ether1` filters RouterOS rows and returns an **array**; the
  caller takes the match. `--query`/`--filter` always return an array — there is
  no singleton-by-name shape. (Decided: the old `<.id|name>` positional is
  dropped.)
- `snmp <oid|MIB name>` — planned retrieve-only SNMP form. OIDs are used
  directly; MIB names are resolved from the cached MikroTik MIB that matches
  the selected RouterOS version/channel once that cache is implemented.

## Flags

Implemented flags are generated from the CLI metadata into
[`docs/CLI.md` → retrieve](../../docs/CLI.md#retrieve); this file does not
duplicate that table. Behavior notes the generated reference cannot carry:

- `--format json` (shortcut `--json`): set `CENTRS_FORMAT=json` to make the
  structured envelope the default. `--format yaml` renders the same envelope.
- `--port`: native-api defaults to 8728; `--port 8729` selects TLS `api-ssl`.
- `--query`/`--filter` are RouterOS **row** filters and always return an
  array (see Synopsis); `--where` filters *which devices* fan out, not rows.
- `--all-attributes` conflicts with `--attribute(s)` (see Validation).
- `--quickchr` resolves host/port/auth from the live `@tikoci/quickchr`
  (0.4.5+, optional dependency) descriptor, bypassing CDB/env resolution for
  those fields.

### Designed, not implemented

Spec-tier flags with no implementation yet — today they fail as unknown flags:

| Flag                                | Designed behavior                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `--once`                            | Bounded single read of a monitor-style menu (RouterOS `once`): returns **one** envelope and never follows. Open-ended follow is `--follow` (below), or `api … <menu>/listen` for the literal wire. See constitution: protocol selection. |
| `--max-bytes <n>`                   | Byte budget for the rendered payload. If the response would exceed it, centrs truncates to fit, keeps `ok: true`, and adds a warning + `meta.truncated`. Not an error. (Will replace the implemented `--max-results`, which fails instead of truncating.) |
| `--max-rows <n>`                    | Maximum row count for list reads. Excess rows are clipped; `ok: true` with a warning + `meta.truncated`.                                    |
| `--yaml`                            | Shortcut for `--format yaml`.                                                             |
| `--ros-version <version>`           | SNMP MIB lookup only: pin the MikroTik MIB version to cache/download.                     |
| `--ros-channel <channel>`           | SNMP MIB lookup only: `stable`, `long-term`, `testing`, or `development`; default `stable`. |

## Validation

Default validator: `/console/inspect request=syntax path=<comma-joined>,print`
(or `,get` for singleton paths). Validator must reject unknown paths and
unknown attributes with `validation/*` codes that include the inspect-suggested
alternatives in the error envelope.

If `--all-attributes` is combined with `--attribute(s)`, fail with
`usage/conflicting-flags` *before* hitting the network.

SNMP validation is separate from RouterOS `/console/inspect`: OIDs and MIB
names must resolve through the MIB cache before any SNMP request is sent.

## SNMP MIB cache policy

Signed off (2026-06-06): cache MikroTik MIBs under the XDG cache root,
`${XDG_CACHE_HOME:-~/.cache}/tikoci/snmp-mibs`, not beside the CDB. The cache is
derived data; deleting it must never remove inventory or credentials. Use one
subdirectory per exact RouterOS version, for example
`routeros/7.23/mikrotik.mib`, plus metadata containing source URL, ETag,
Last-Modified, SHA-256, fetched-at, and the channel (if a channel resolved it).

Version selection for MIB-name lookup is deterministic. `--ros-version` wins and
downloads `https://download.mikrotik.com/routeros/<version>/mikrotik.mib`.
Otherwise `--ros-channel` (default `stable`) is resolved through
`https://upgrade.mikrotik.com/routeros/NEWESTa7.<channel>` and that exact version
is used. If target metadata already carries a RouterOS version from a trusted
source, it may supply the default version, but the SNMP path must not make an
extra REST/native call merely to discover a version.

Invalidation is by exact version plus HTTP validators. A missing version cache is
downloaded before lookup; an existing cache is reused offline. When online, a
cache older than 24h is revalidated with ETag/Last-Modified and replaced
atomically if MikroTik republishes the file. Channel pointers are short-lived:
re-resolve the channel after 24h, then use the cache for the resulting exact
version.

Offline behavior is intentionally conservative. Numeric OIDs do not require the
MIB cache and proceed normally. MIB-name lookup succeeds only when the selected
exact version is already cached; if not, fail before SNMP I/O with
`snmp/mib-cache-miss` and a fix that tells the caller to go online once or pass a
cached `--ros-version`. Do not silently fall back to a different version's MIB.

RouterOS grounding: MikroTik documents SNMP as retrieve/write-capable but centrs
uses it as retrieve-only; the same page points users to the MikroTik MIB download
surface. The per-version `mikrotik.mib` URL under `download.mikrotik.com` has
been verified for current stable/development versions, but treating it as the
long-term canonical URL is an assumption until the implementation has fallback
handling.

## Output shape

```ts
{
  ok: true,
  data: [ { ".id": "*1", address: "192.0.2.1/24", ... }, ... ],   // array of rows
  // or for singletons (e.g. /system/resource):
  // data: { uptime: "...", "cpu-load": 7, ... },
  // or for --attribute:
  // data: "192.0.2.1/24",       // single value
  meta: { target, via, settings, validation, timing }
}
```

`--max-bytes` / `--max-rows` truncation populates
`meta.truncated = { returned, total, totalBytes }` and keeps `ok: true` with a
warning entry — it is not an error. (Earlier text said a byte overflow returns an
*error* with the needed size; superseded — truncation is an `ok: true` footnote so
partial data stays usable.)

## Query (`--query`)

`retrieve <router> <menu> --query '<expr>'` returns only the rows that match,
filtered on the router. `<expr>` is what you would write after `print where`:

```bash
centrs retrieve $R /interface --query 'type=ether and !disabled'
centrs retrieve $R /ip/route --query '(dst-address="0.0.0.0/0" or distance>=10) and active'
```

`--filter` is the same flag. Repeat either, and the expressions are AND-ed. A
list read with `--query` is always an array, `[]` when nothing matches. The
result works with `--attribute(s)`, `--sample` and fan-out; `--follow` does not
take it yet (#397). A singleton (`/system/identity`) has no rows to filter and
fails `usage/conflicting-flags`.

**What it compiles to.** centrs parses the expression before connecting and
sends it as the API query (native `?` words, REST `.query`; one language,
`commands/api/AGENTS.md`). The router evaluates it, so comparisons use
RouterOS's own per-property typing:

| You write | RouterOS query words |
| --------- | -------------------- |
| `a=v`, `a!=v` | `a=v`; `a=v` `#!` |
| `a<v`, `a>v` | `<a=v` `-a` `#\|`; `>a=v` |
| `a<=v`, `a>=v` | `>a=v` `#!`; `<a=v` `-a` `#\|` `#!` |
| bare `a` | `a=yes` if `a` is a boolean, otherwise `a` (has a value) |
| `!x`, `x and y`, `x or y` | x `#!`; x y `#&`; x y `#\|` |

As in `print where`, a row without the property counts as smaller than any
value: `timeout<1d` includes static address-list entries (no `timeout`), and
`timeout>1h` does not. API `<`/`>` skip such rows on their own, hence the `-a`
("has no `a`") word. `and` (`&&`) binds tighter than `or` (`||`), as in RouterOS. Values run to the
next space or parenthesis, and start right after the operator (RouterOS
rejects `comment= x`). Quote a value with spaces or an `=` (`comment="uplink a"`,
`comment="x=yes"`), using RouterOS escapes: `\"`, `\\`, `\$`, `\?`, `\_`, `\a`
`\b` `\f` `\n` `\r` `\t` `\v`, and two uppercase hex digits (`\41`; `\ff` is `\f`
then `f`). A backslash before whitespace drops it and the whole whitespace run
after it, so `"x\<newline>  y"` is `xy`. A hex
byte above `\7F` is refused: centrs sends values as UTF-8, so it could not match
the raw byte RouterOS stores.

**A bare name.** `where disabled` means `disabled=yes`, but `where comment`
means "comment is set" (RouterOS stores an empty comment as absent). Only the
router knows which kind a property is, so centrs asks it: `/console/inspect`
completion after `where <name>=` offers exactly `yes`/`no` for a boolean. With
`--validate=false` there is no one to ask, and a bare name fails
`input/invalid-query`; write `disabled=yes`.

**Validation.** Every property in the expression is checked against the
menu's attributes (as for `--attributes`, plus `.id`). RouterOS answers a query
on a misspelled property with no rows and no error, so a typo fails
`validation/unknown-attribute` instead.

**Same rows as `print where`, with these differences.** On CHR 7.23.7 and
7.24.5, 58 expressions over three menus return exactly the rows
`find where` selects (examples QY1, QY2). The exceptions come from the CLI
typing an unquoted literal, which the query does not do:

- `where dst-port=80` reads `80` as a number and matches nothing, and
  `where protocol=tcp` likewise; the query matches the `"80"` and `"tcp"` that
  `retrieve` shows. Quoted (`dst-port="80"`), the CLI agrees.
- Ordering (`<`, `>`, `<=`, `>=`) on a property RouterOS returns as text
  (address-list `address`, `dst-port`) is text order: `192.0.2.10` sorts
  before `192.0.2.9`. Numbers (`mtu`, `vlan-id`, `distance`) compare as
  numbers.
- The query accepts `disabled=true` as `yes`; the CLI rejects it.

**Refused, never approximated.** `~` (regex) and `in` (prefix membership) have
no query word, and a `$variable`, `[command]` or `{array}` value needs the
script evaluator: these fail `input/unsupported-query` with a tip. Four
spellings RouterOS reads differently from how they look fail
`input/invalid-query`: `!a=v` (RouterOS reads `(!a)=v`; write `!(a=v)` or
`a!=v`), `not` (not a RouterOS operator; use `!`), conditions separated
only by a space (join them with `and` or `or`), and an unquoted `=` inside a
value (RouterOS reads `comment=x=yes` as `(comment=x)=yes`, and `comment=x!=y`
matches nothing; quote it: `comment="x=yes"`).

## Follow (`--follow`)

`retrieve <router> <menu> --follow` keeps a menu's rows current: first the
rows that exist now, then a line for every change, as NDJSON. It is the
friendly wrapper over native-API `listen`; `api <router> <menu>/listen` is the
literal wire (`commands/api/README.md`). Decisions and CHR evidence: #396.

**What starts it.** `--follow` on a list menu whose `print` takes
`follow-only` in `/console/inspect` (checked live). A menu without it, a
singleton included, fails `validation/not-followable` before anything is
followed. Native-api only: an unset `via` infers native-api, and a `via` of
`rest-api` from any source (flag, env, CDB, settings) fails
`transport/capability-unsupported`; there is no polling fallback. Single
target only: a fan-out selector fails `usage/fanout-not-supported`. Follow is
unfiltered for now: `--query` with `--follow` fails `validation/not-implemented`
until filtered follow lands (#397).

**What each line means.** Every line is one envelope; read
`meta.operation.stream`:

| `kind` | When | `data` | Fields |
| ------ | ---- | ------ | ------ |
| `frame` | One row change | the row (`upsert`), `null` (`removed`) | `index`, `phase` (`snapshot`/`live`), `change` (`upsert`/`removed`), `id`, `source` (`print`/`listen`/`sweep`) |
| `synced` | Once, after the snapshot | `null` | `rows`: rows held at that point |
| `notice` | First, only when there is advice | `null` | — (`tips` carries it) |
| `summary` | Last, exactly once | the counts | `stopReason`, `frames`, `snapshot`, `changes`, `sweeps`, `synced`, `durationMs` |

- **Bootstrap (A1).** centrs starts the `listen`, then the `print`, on one
  connection. It emits the `print` rows, then every `listen` change received
  since the `listen` started, all as `phase: "snapshot"`, then `synced`.
  Applying the lines in order gives the menu's state at `synced`. That order
  had 0 errors over about 14.7k writes on 7.23.7 and 7.24.5; merging by arrival
  order resurrects deleted rows (#396 round 3). `synced` means the bootstrap
  was processed. It is not an atomic snapshot, a full event history, or
  routing convergence.
- **`upsert`** carries the latest full row; replace what you hold for `id`.
  **`removed`** carries `data: null`; drop `id`. The row identity is always
  `meta.operation.stream.id`, even when `--attributes` leaves `.id` out of
  `data`.
- **Changes are coalesced state, not an event log.** RouterOS sends a change
  about 200 ms after a write and folds writes in between. A row created and
  deleted inside that window may never appear, and a flap may arrive as one
  line or none. A `.dead` for an `id` centrs never reported is dropped, so a
  removal the sweep saw first is reported once, as `source: "sweep"`.
- **Removals RouterOS does not send.** View menus (`/interface/<type>`,
  `/ip/route`, `/ipv6/route`) never send `.dead`. An `.id`-only sweep
  (`print .proplist=.id`) runs every `--sweep` (default `10s`) on every followed
  menu and reports an `id` that is gone as `removed` with `source: "sweep"`.
  An `id` that changed since that sweep was sent is never removed by it. A
  failed sweep ends the follow with an error; it never infers a removal. A
  sweep only checks membership: it does not repair a missed field update or
  report rows `listen` never announced. `--sweep` needs a unit (`10s`,
  `500ms`); a bare number fails `settings/invalid-timeout`, as for `--sample`.
  `--sweep 0` turns it off, with a notice tip saying view-menu removals will
  not be reported.
- **What `listen` never reports.** Hot counters (`rx-byte`, firewall
  `bytes`/`packets`) and some protocol state (BFD sessions accept `listen` but
  stay silent). The follow is correct but quiet there; `--sample` (below)
  is the answer for those.
- **Projection.** `--attribute(s)` projects `data`; centrs still asks RouterOS
  for `.id,.dead` and removes them from `data` unless you named them.
  `--all-attributes` sends `detail` to both `listen` and `print`.
  `--list-attributes` and `--max-results` conflict with `--follow`
  (`usage/conflicting-flags`).

**What ends it.** `--count N` stops after N `live` frames; snapshot frames and
`synced` never count, so `--count 1` is "the next observed change" (coalesced,
so not a guaranteed transition). `--duration <d>` is a wall-clock bound that
includes the bootstrap. Ctrl-C (`SIGINT`) stops it. Each ends with a
successful summary whose `stopReason` is `count-reached`, `duration-elapsed`,
or `interrupted`. A RouterOS error, a lost connection, a failed sweep or a full
buffer ends it with a failed summary (`ok: false`, `stopReason`
`routeros-error` or `transport-error`), whose counts are partial.
`routeros-error` means RouterOS answered with an error; `transport-error`
covers every other failure, and `error.code` names the cause. Buffers are
bounded: if more than 50,000 changes are waiting (a consumer that stopped
reading, or a burst during a long snapshot), the follow ends with
`transport/stream-overflow`. The state you hold is stale; follow again to get a
new snapshot. `--sweep` without `--follow`, and `--count` or `--duration`
without `--follow` or `--sample`, fail `usage/conflicting-flags`.

**Format.** Under `--follow`, `json`, `yaml` and `ndjson` all print one compact
envelope per line (as `api --stream` does); `text` prints one short row per
line. Every envelope, errors included, goes to stdout, and the exit code is
nonzero for any failure, even after rows. Without `--follow`,
`--format ndjson` prints the ordinary envelope as one compact line; it never
starts a follow.

Recipes (bounded, so an agent can run them unattended):

```bash
# Watch: hold /ip/address for 30s, then stop.
centrs retrieve $R /ip/address --follow --duration 30s
# Wait for the next change, at most 60s.
centrs retrieve $R /ip/address --follow --count 1 --duration 60s
```

## Sample (`--sample`)

`retrieve <router> <menu> --sample <interval>` reads the menu again every
interval: one line per complete read, as NDJSON. It sees what `--follow`
cannot (hot counters such as `rx-byte`, and state `listen` never announces),
at the cost of missing whatever changes and changes back between two reads.

**What starts it.** `--sample` with an interval that has a unit (`5s`,
`500ms`, `1m`). A bare number fails `settings/invalid-timeout`: RouterOS reads
`interval=5` as seconds and centrs reads `5` as milliseconds, so centrs does
not guess. Any readable menu works, list or singleton. Each sample is the
ordinary one-shot read (`print` or `get`) with the same validation (once, before
the first read), projection and transport as `retrieve` without `--sample`:
`rest-api` by default, `native-api` when pinned. Single target only; a fan-out
selector fails `usage/fanout-not-supported`. `--follow` with `--sample` fails
`usage/conflicting-flags`.

Why reads and not RouterOS's own `print interval=`: on CHR 7.24.5 that feed has
no end-of-tick marker, so a tick is only known complete when the next tick (or
`!empty`) arrives, one whole interval later. A tick heavier than its interval
also stalls the connection. A one-shot read ends with its own `!done` or HTTP
response, so every sample is known complete when it arrives. The raw tick feed
stays available as `api <router> <menu>/print -X POST -f interval=1s --stream`
(`commands/api/README.md`).

**What each line means.** Every line is one envelope; read
`meta.operation.stream`:

| `kind` | When | `data` | Fields |
| ------ | ---- | ------ | ------ |
| `sample` | One complete read | the whole read: a row array (list), the record (singleton), or the bare value (one `--attribute` on a singleton) | `index` (1-based), `at` (when the read was sent, host clock, ISO 8601), `readMs` |
| `summary` | Last, exactly once | the counts | `stopReason`, `samples`, `durationMs` |

- **A sample is the whole state at that read.** A row missing from a sample
  was gone when it was read; there is no separate removal line. A list read
  with no rows is `data: []`, still a complete sample.
- **Cadence.** Reads start one interval apart, measured start to start. A
  read slower than the interval delays the next read rather than overlapping
  it, and missed slots are not made up in a burst. `at` gives the real spacing,
  which is what a counter rate needs.
- **Not an event log.** A change shorter than the interval can fall between
  two reads. Use `--follow` for object changes RouterOS announces.

**What ends it.** `--count N` stops after N samples. `--duration <d>` is a
wall-clock bound counted from the end of validation. Ctrl-C (`SIGINT`) stops
it. Each ends with a successful summary whose `stopReason` is `count-reached`,
`duration-elapsed` or `interrupted`. A read still in flight when the run stops
is not reported, because it is not complete. A failed read (a RouterOS error,
a lost connection, a timeout) ends the run with a failed summary (`ok: false`,
`stopReason` `routeros-error` or `transport-error`, as for `--follow`)
carrying the partial `samples` count; there is no retry. `--list-attributes`, `--max-results` and
`--sweep` conflict with `--sample` (`usage/conflicting-flags`).

**Format.** As for `--follow`: `json`, `yaml` and `ndjson` print one compact
envelope per line, and `text` prints `index`, `at` and the data on one line.
Every envelope, errors included, goes to stdout; the exit code is nonzero for
any failure, even after samples.

Recipes (bounded, so an agent can run them unattended):

```bash
# Interface counters every 5s, three samples.
centrs retrieve $R /interface --attributes name,rx-byte,tx-byte --sample 5s --count 3
# CPU load once a second for a minute.
centrs retrieve $R /system/resource --attribute cpu-load --sample 1s --duration 1m
```

## Target selection

retrieve fans out over the **shared target-selection grammar** — multiple
`<router>` positionals, repeatable `--group`/`--where`, the geo selectors
`--near`/`--bbox`, `--all`, and `--default`, combined as a set and de-duped by
CDB record index. The grammar, the locked `FanoutData`
envelope (`data = { summary, targets[] }`, outer `ok` = orchestration success,
per-target failure is an inner `ok:false`), the record-order reassembly, and the
granular **0/2/1 exit code** are all normative in
[`docs/CONSTITUTION.md` → Target selection grammar](../../docs/CONSTITUTION.md#target-selection-grammar).
The boundary is intent-keyed: a plain single-positional `retrieve <router> <path>`
stays the single-target envelope; a selector flag or a second positional target
switches to fan-out. `--quickchr <name>` (the named-live-provider) behaves like a
lone positional: one flag stays single-target, repeating it fans out, and mixing
it with positionals or CDB selectors is `usage/conflicting-flags` (constitution:
resolution providers).

retrieve-specific behavior on top of the shared engine:

- The CDB is loaded + decrypted **once** for the whole fan-out; each target is
  then resolved and **validated independently**, because RouterOS schemas can
  differ by version (`/console/inspect` runs per target).
- An empty or unknown selection is `ok: true` with
  `data.summary = { total: 0, ok: 0, failed: 0 }`, `data.targets = []`, a
  `cdb/empty-group` / `cdb/empty-selection` warning, and exit `0`.
- Each target retries up to two times **only** for `transport/network` and
  `transport/connection-closed` (REST 5xx is mapped to
  `transport/connection-closed`). It does **not** retry `routeros/*`,
  `validation/*`, `auth/*`, `cdb/*`, `target/*`, timeouts, DNS, TLS, or refused
  connections.

## Definition of done

This command is `CHR-passed` only when every line in `examples.md` runs green
against a real CHR through `bun run test:integration`. Disabling validation to
reach green is forbidden. See `docs/CONSTITUTION.md` for the full done rule.

## Notes for future cells

- **native-api** — implemented for retrieve (`--via native-api`, `CHR-passed`;
  see `examples.md` N1–N11 and `test/integration/native-api-retrieve.test.ts`).
  Validation still runs through `/console/inspect` (issued as a native-API
  command). Attribute values arrive as strings because the binary API carries
  no JSON scalar types; the envelope shape is otherwise identical to REST.
- **snmp** — retrieve-only OID/MIB reads. It does not validate through
  `/console/inspect` and does not execute RouterOS CLI.
- **ssh / mac-telnet / romon / winbox-terminal** — execute surfaces, not
  retrieve surfaces.
- **tips** — when a `<router>` fails to resolve against an empty CDB, retrieve
  emits the same `tip/no-devices` advice as `devices list`, steering toward
  `centrs devices discover` and `centrs settings`.
