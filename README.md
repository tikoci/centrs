# centrs

`centrs` is the tikoci RouterOS interaction hub: a Bun/TypeScript library and
CLI (with an MCP server; TUI and HTTP proxy frontends planned) for talking to
MikroTik RouterOS devices through a regularized, validated interface.

Stable releases are published on npm under `latest`. To try the offline
analyzer without installing centrs or connecting to a router:

```bash
bunx @tikoci/centrs@latest explain '/ip/address print' --json
```

Use `bunx @tikoci/centrs@latest --help` to inspect the release CLI, and
`bunx @tikoci/centrs@latest --version` (`-V`; `--json` for an envelope) to print
the exact version for scripts and field reports. The dist-tag follows standard
SemVer semantics: a plain version (`0.1.10`) publishes to `latest` and carries
`next` forward with it, while a `next` build (`0.1.11-next.23`) publishes to
`next` only and never moves `latest`. A `next` build is described by the
next version's `## X.Y.Z — next` section of [`CHANGELOG.md`](CHANGELOG.md).
So `@next` is the leading edge and can equal `@latest` between cuts —
`npm view @tikoci/centrs dist-tags` is the authority.

The full flag reference for every command is generated from the CLI metadata
into [`docs/CLI.md`](docs/CLI.md); per-command behavior lives in
`commands/<name>/README.md`.

It is a **friendly conduit**, not a high-level configuration abstraction. It
helps humans and agents reach RouterOS over the right protocol, with the right
credentials and ports, and validates RouterOS-shaped commands before running
them. It does **not** hide RouterOS behind helpers like `createVlanOnBridge()`
— you still speak RouterOS. Validation and structured diagnostics are the
product; without them this would just be a worse `curl`.

> **Status:** early npm preview under active development. It is not
> production-ready: expect bugs and breaking changes before 1.0, and exercise
> router-writing workflows on lab or disposable targets first. Offline
> `explain` does not contact a router, but its analysis is intentionally
> conservative and never proves that RouterOS will accept a command at runtime.
> Check current dist-tags with
> `npm view @tikoci/centrs dist-tags --json`. The library, device registry, and
> first MCP server phases are CHR-verified; the CLI is wired (`coded`);
> encrypted-CDB reads and writes are supported, and the TUI/proxy frontends
> are planned.
> `docs/MATRIX.md` is the single source of truth for what works today — treat
> anything not green there as not-yet-shipped.
> The [0.1.10 known issues](CHANGELOG.md#known-issues) cover MAC-Telnet output
> loss (#575) and the MCP authorization race during concurrent CDB edits (#604).

## What it talks to, and how

- **Frontends:** TypeScript API, CLI, MCP server (Phase 1 + first Phase 2 CDB
  mutation `CHR-passed` — see `commands/mcp/`), TUI and HTTP proxy/daemon
  (future).
- **Protocols:** REST API and native API for reads and writes; SSH / MAC-Telnet
  for execution and interactive terminals; SFTP for file transfer; MNDP for
  discovery; bandwidth test for peer measurement. RoMON and WinBox Terminal
  are planned. centrs picks the protocol for you (and lets you pin one
  with `via=` or `--via`).
- **Commands:** every router-facing command resolves a *target* — a router you
  name on the CLI — to a real address, credentials, and a protocol, then runs.
  (Local commands — `devices`, `settings`, `discover`, and `explain`'s offline
  mode — need no router.)

| Command    | Purpose |
| ---------- | ------- |
| `retrieve` | Read RouterOS state over REST/native API. `--follow` keeps a menu's rows current over native API (snapshot, then a line per change; NDJSON); `--sample <interval>` re-reads it on a timer for counters; `--query` filters on the router with the `print where` grammar; `--wait` retries until a read succeeds (or an optional `--until` condition holds), up to a deadline. |
| `execute`  | Run RouterOS CLI-shaped read/write commands (add/set/remove) over native API, REST, SSH or MAC-Telnet. |
| `api`      | Structured RouterOS API passthrough (gh-api style): one command per operation, structured in/out, can write, over REST or native API. Follow changes with `api … <menu>/listen`; `--stream` streams any command's replies (native API; NDJSON). |
| `terminal` | Open an interactive console, primarily SSH or MAC-Telnet. |
| `transfer` | Upload, download and manage device files over REST/native API or SFTP; `upload` and `download` are shortcuts. |
| `btest`    | Run a MikroTik bandwidth-test client or server over TCP/UDP. |
| `check`    | Probe reachability and management protocol availability. **Designed, not implemented** — see `docs/MATRIX.md`. |
| `explain`  | Analyze RouterOS source offline, or add read-only device evidence over REST/native API, including path schemas, completion candidates and value types. Runtime acceptance remains unproven. |
| `devices`  | View and maintain the CDB-backed device registry (the only writer). |
| `discover` | Discover MNDP neighbors and optionally save them into the CDB. |
| `settings` | Manage centrs's global preferences (`centrs.env`) and inspect the `__default__` record. Interactive first-time setup is planned. |

Each command's `commands/<name>/` directory carries its design and the
executable example list that gates "done".

## Your WinBox address book *is* the device registry

centrs deliberately has **no separate credential vault or inventory
database**. Instead it piggybacks on the one most RouterOS admins
already keep: the WinBox connection database (CDB), the `winbox.cdb` file that
WinBox writes when you save a router in its address book.

Global preferences live in `centrs.env`, managed by `settings`; device records
and saved credentials stay in the CDB. See the
[`settings` contract](commands/settings/README.md).

centrs reads (and, through `devices`, writes) that same file at its well-known
location, `~/.config/tikoci/winbox.cdb` (override with `--cdb-file` /
`CENTRS_CDB_FILE`). From each saved entry it takes the fields WinBox already
stores:

- **`target`** — the address you saved (IPv4, IPv6, MAC, or DNS name); a literal
  you can type at the CLI to reach the box. centrs *also* resolves a `<router>`
  against three sanctioned comment lookup keys — `identity=`, `mac=`, and `ip=` —
  so a router whose `target` is `192.0.2.5` is still reachable as `edge1` when its
  comment carries `identity=edge1`. Every other comment token stays inert prose.
  See `commands/devices/README.md` (Identity model) for the full resolution rules.
- **`user` / `password`** — the credentials centrs connects with. They stay in
  the CDB. `devices show` / `add` / `set` withhold the password and report
  `passwordSet` (`--show-password` reveals it); MCP results/resources always
  redact it.
- **`group` and port** — used for selection and connection settings.
  **`profile` and `session`** are preserved for WinBox compatibility; centrs
  does not act on them.

So `centrs retrieve edge1 /ip/address` works with no flags: `edge1` is looked
up in the CDB, its credentials and address come along for the ride. A target
that *isn't* in the CDB still works, but then `--username` / `--password` (or
`CENTRS_USERNAME` / `CENTRS_PASSWORD`) become mandatory.

### Overloading the comment: per-device settings as `key=value`

A WinBox CDB entry has no field for "always use SSH for this box" or "skip
validation here" — those are centrs concepts WinBox knows nothing about. Rather
than invent a parallel store, centrs **overlays its own settings onto the one
free-text field WinBox does have: the comment.** It parses `key=value` tokens
(the "comment kv-soup") out of that free text and treats the recognized ones as
per-device defaults. Everything else in the comment stays inert human prose.

A comment like:

```text
edge1 prod border router   via=ssh validate=false mcp=rw
```

leaves `edge1 prod border router` as plain text for you and WinBox, while
centrs reads three settings from it. The recognized keys:

| Key        | Effect                                                                  |
| ---------- | ----------------------------------------------------------------------- |
| `via`      | Default transport for this device (`rest-api`, `native-api`, `ssh`, …). |
| `validate` | `true` / `false`. `false` is the escape hatch; a CLI flag still wins.   |
| `timeout`  | Default request timeout in ms (per-transport caps still apply).         |
| `port`     | Non-default transport port.                                            |
| `www-port`, `www-ssl-port`, `api-port`, `api-ssl-port`, `ssh-port` | Per-service port, named after `/ip/service`. Only the matching transport reads it (REST, native API, SSH); it beats `port`, which applies to every transport. |
| `ssh-key`  | Path to a per-device SSH private key (a path only — never key material).|
| `source`   | Provenance marker for discovered/imported records (`mndp`, `dude`, …).  |
| `mcp`      | MCP write policy: `ro` (default) or `rw`. See below.                    |

The first-class fields WinBox already stores (`user`, `password`, `group`,
`profile`, `session`) must **not** be written into the comment — they have real
CDB tags, and `devices set` refuses to put them there. Unknown keys produce a
`cdb/unknown-option` warning and are ignored, so a stray `=` in human prose
never breaks anything.

Settings resolve lowest-to-highest: **built-in defaults → user config file
(`centrs.env`) → comment-kv → `CENTRS_*` env → CLI flag / API arg.** Every
result envelope reports which source won each setting under `meta.settings`,
so you can always see *why* a given port or transport was chosen.

### Groups, discovery, and the MCP allowlist all ride on the CDB

- **Groups** are CDB-native: an entry's `group` field is just a string, and
  `--group prod-edge` fans a single command out to every entry that shares it.
  There is no separate group-definition file. Groups are one selector in a
  **uniform fan-out grammar** shared by `api`, `retrieve`, `execute`, and
  `transfer`: mix `<router>` positionals, repeatable `--group`/`--where
  <attr>=<value>`, `--all`, and `--default` (de-duped by CDB record index). Every
  fan-out returns the locked `FanoutData` envelope (per-target results, not
  metadata) with a granular exit code (`0` all ok / `2` partial / `1` all failed);
  a multi-target write is gated once by `--yes` naming the blast radius. See
  `docs/CONSTITUTION.md` (Target selection grammar).
- **CMR fleets** (RouterOS 7.26beta1+) are selected on the controller instead:
  `execute <controller> --cmr --labels <expr> -- '<command>'` validates the
  command on each client through CMR and runs it there, using only the
  controller's credentials. See `commands/execute/README.md` (CMR).
- **Discovery** writes back into the CDB: `discover --save` records MNDP
  neighbors as new entries tagged `group=discovered` with a `source=mndp`
  marker — hints to curate, not authoritative inventory.
- **The MCP server uses the CDB as its authorization boundary.** The allowlist
  checks that a target exists in the CDB; RouterOS write-shaped execution
  requires the entry to carry `mcp=rw` plus per-call confirmation.
  `centrs_devices` can also add/set/remove CDB records in-band, and
  `centrs_discover` can save MNDP neighbors, with `confirm: true`. The allowlist
  and the write policy are *the same CDB data* you already manage — see
  `commands/mcp/`. Concurrent CDB edits can invalidate the checked record before
  dialing (#604); see the [security policy](SECURITY.md#device-access-and-cdb-integrity).

`devices` owns CDB mutations, including those requested through MCP or
`discover --save`. Record mutations use a cross-process lock, a loaded-revision check,
timestamped backups (two retained by default), and atomic rename, preserving
unknown WinBox fields verbatim. High-level library mutations reject stale
`LoadedCdb` snapshots with `cdb/conflict`. The low-level `writeWinBoxCdb()`
requires `expectedRevision` to enable locking and revision checks; omitting it
skips both protections. `devices init` uses atomic no-clobber creation instead.
CLI/MCP add, set and remove operations and `discover --save` reload and retry.
Close WinBox before mutating the same file: external writers do not take the
centrs lock.
Encrypted-CDB reads and writes work with `--cdb-password` /
`CENTRS_CDB_PASSWORD`; writes decrypt, mutate and re-encrypt with a fresh salt.
`devices init --encrypt` creates an encrypted registry, and `devices encrypt`
explicitly converts an existing open CDB. Conversion retains existing backups
and warns that plaintext copies remain. The manual WinBox round-trip is still
pending; see the per-command contract for the current evidence and limits.
The full contract — identity resolution, ambiguity handling, write strategy,
and the comment grammar — lives in `commands/devices/README.md` and
`docs/CONSTITUTION.md` (Identity and CDB).

## The result envelope, validation, and errors

- **Validation is on by default** (`validate=true`). CLI-shaped `execute` and
  `api /execute` scripts pass the offline analyzer before device validation.
  Reads are checked through `/console/inspect`; CLI-shaped commands through
  `[:parse]`. Set `validate=false` (per device or per call) only as a deliberate
  escape hatch.
- **Every call returns one envelope:** `{ ok, data?, warnings, tips, error?, meta }`,
  with provenance and source-of-truth reporting in `meta`.
- **Errors are typed values**, not thrown strings, with slash-namespaced codes
  (`routeros/…`, `transport/…`, `validation/…`, `cdb/…`) and a `details_url`
  of the form `https://tikoci.github.io/centrs/errors/<code>` for the
  human-readable explanation.

The load-bearing contract — envelope shape, error model, protocol selection,
settings precedence, and the "done" definition — lives in
`docs/CONSTITUTION.md`. Capability status, the current track and parked
themes, including the command×protocol grid and offline analysis, live in
`docs/MATRIX.md`.

## Repository layout

For contributors. An admin only needs the CLI and their CDB; this is where the
code and authority docs live.

- **`docs/CONSTITUTION.md`** — load-bearing rules (validation, envelope, error
  model, settings precedence, identity/CDB, protocol selection, done).
- **`docs/MATRIX.md`** — capability status, the current track, parked themes
  and nits (the command×protocol grid plus offline analysis and frontend
  surfaces); the only status surface.
- **`commands/<name>/`** — per-command README and executable examples.
- **`src/`** — Bun/TypeScript source.
- **`test/`** — unit and CHR-backed integration tests.

There is no `docs/specs/`, no `work/`, no roadmap doc. The matrix and the
GitHub issues it links are the roadmap.

## Development

Requirements:

- Bun 1.4.4 or newer within 1.x (`engines.bun`: `>=1.4.4 <2`; CI runs the
  `packageManager` version in `package.json`; Bun 2.x not yet validated).
- Git.
- `uv`, only for `bun run lint:actions` (zizmor workflow audit).
- For integration tests: QEMU plus `@tikoci/quickchr` (handles CHR image
  download and boot).

```bash
bun install
bun run lint
bun run test
bun run test:integration   # CHR-backed; required before claiming "done" on transport code
bun run test:integration:long-term  # channel-specific CHR gate
bun run build
```

Generated API docs through TypeDoc:

```bash
bun run build:doc:api
```

The `explain` censuses measure a RouterOS script corpus that lives in
[`tikoci/lsp-routeros-ts`](https://github.com/tikoci/lsp-routeros-ts), not in
this repo. `scripts/corpus-pin.json` records which snapshot centrs measures
against — a commit plus the blob's sha256 — and `corpus:fetch` downloads and
verifies it. A sibling `lsp-routeros-ts` checkout is used when present, and the
censuses print the source and hash they used:

```bash
bun run corpus:fetch          # download the pinned snapshot, verify its sha256
bun run explain:corpus-census # genre census (#203)
bun run explain:value-census  # value-surface census (#225)
```

## Done definition (short version)

Live capabilities require every applicable example in `commands/<name>/examples.md`
green on real CHR via `bun run test:integration`. Offline analysis requires its
command README's full baseline acceptance criteria, including committed
CHR-grounded semantic evidence. The fixture-backed `devices` and `settings`
integration suites retain their command-specific contracts. Full rule:
[`docs/CONSTITUTION.md` → Done definition](docs/CONSTITUTION.md#done-definition).
