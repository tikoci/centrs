# centrs

`centrs` is the tikoci RouterOS interaction hub: a Bun/TypeScript library and
CLI (with MCP, TUI, and HTTP proxy frontends planned) for talking to MikroTik
RouterOS devices through a regularized, validated interface.

Preview builds are published on npm. To inspect the CLI without installing it:

```bash
bunx @tikoci/centrs --help
```

It is a **friendly conduit**, not a high-level configuration abstraction. It
helps humans and agents reach RouterOS over the right protocol, with the right
credentials and ports, and validates RouterOS-shaped commands before running
them. It does **not** hide RouterOS behind helpers like `createVlanOnBridge()`
— you still speak RouterOS. Validation and structured diagnostics are the
product; without them this would just be a worse `curl`.

> **Status:** early npm preview, active development. `@tikoci/centrs` is
> published on npm, but command flags and envelopes may still change before a
> stable release. Check current dist-tags with
> `npm view @tikoci/centrs dist-tags --json`. The library, device registry, and
> first MCP server phases are CHR-verified; the CLI is wired (`coded`);
> encrypted-CDB writes are still blocked, and the TUI/proxy frontends are planned.
> `docs/MATRIX.md` is the single source of truth for what works today — treat
> anything not green there as not-yet-shipped.

## What it talks to, and how

- **Frontends:** TypeScript API, CLI, MCP server (Phase 1 + first Phase 2 CDB
  mutation `CHR-passed` — see `commands/mcp/`), TUI and HTTP proxy/daemon
  (future).
- **Protocols:** REST API (preferred), native API, and SNMP for reads;
  SSH / MAC-Telnet / RoMON / WinBox Terminal for interactive and L2 execute;
  MNDP for discovery. centrs picks the protocol for you (and lets you pin one
  with `via=` or `--via`).
- **Commands:** every command resolves a *target* — a router you name on the
  CLI — to a real address, credentials, and a protocol, then runs.

| Command    | Purpose |
| ---------- | ------- |
| `retrieve` | Read RouterOS state over REST/native API and SNMP OID/MIB values. |
| `execute`  | Run RouterOS CLI-shaped read/write commands (add/set/remove) over native API/REST/L2 surfaces. |
| `api`      | Structured RouterOS API passthrough (gh-api style): one command per operation, structured in/out, can write, over REST or native API. Open-ended follow is `api … --stream` (native API; NDJSON). |
| `terminal` | Open an interactive console, primarily SSH or MAC-Telnet. |
| `check`    | Probe reachability and management protocol availability. |
| `devices`  | View and maintain the CDB-backed device registry (the only writer). |
| `discover` | Discover MNDP neighbors and optionally save them into the CDB. |
| `settings` | Manage centrs's own settings (`centrs.env`, `__default__`) and run first-time setup. |

Each command's `commands/<name>/` directory carries its design and the
executable example list that gates "done".

## Your WinBox address book *is* the device registry

centrs deliberately has **no config store, credential vault, or inventory
database of its own**. Instead it piggybacks on the one most RouterOS admins
already keep: the WinBox connection database (CDB), the `winbox.cdb` file that
WinBox writes when you save a router in its address book.

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
  the CDB and are redacted from MCP results/resources.
- **`group`, `profile`, `session`, port** — used as-is.

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
| `ssh-key`  | Path to a per-device SSH private key (a path only — never key material).|
| `source`   | Provenance marker for discovered/imported records (`mndp`, `dude`, …).  |
| `mcp`      | MCP write policy: `ro` (default) or `rw`. See below.                    |

The first-class fields WinBox already stores (`user`, `password`, `group`,
`profile`, `session`) must **not** be written into the comment — they have real
CDB tags, and `devices set` refuses to put them there. Unknown keys produce a
`cdb/unknown-option` warning and are ignored, so a stray `=` in human prose
never breaks anything.

Settings resolve lowest-to-highest: **built-in defaults → project config →
comment-kv → `CENTRS_*` env → CLI flag / API arg.** Every result envelope
reports which source won each setting under `meta.settings`, so you can always
see *why* a given port or transport was chosen.

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
- **Discovery** writes back into the CDB: `discover --save` records MNDP
  neighbors as new entries tagged `group=discovered` with a `source=mndp`
  marker — hints to curate, not authoritative inventory.
- **The MCP server uses the CDB as its authorization boundary.** Agents can
  only reach targets that exist in the CDB; RouterOS write-shaped execution
  requires the resolved entry to carry `mcp=rw` plus per-call confirmation.
  `centrs_devices` can also add/set/remove CDB records in-band, and
  `centrs_discover` can save MNDP neighbors, with `confirm: true`. The allowlist
  and the write policy are *the same CDB data* you already manage — see
  `commands/mcp/`.

`devices` is the only command that writes the CDB, and it does so safely
(timestamped backup, atomic rename, unknown WinBox fields preserved verbatim).
Encrypted-CDB **reads** work with `--cdb-password` / `CENTRS_CDB_PASSWORD`;
encrypted **writes** are currently blocked pending a verified WinBox round-trip.
The full contract — identity resolution, ambiguity handling, write strategy,
and the comment grammar — lives in `commands/devices/README.md` and
`docs/CONSTITUTION.md` (Identity and CDB).

## The result envelope, validation, and errors

- **Validation is on by default** (`validate=true`). Reads are checked through
  `/console/inspect`; CLI-shaped `execute` commands through `[:parse]`. Set
  `validate=false` (per device or per call) only as a deliberate escape hatch.
- **Every call returns one envelope:** `{ ok, data?, warnings?, error?, meta }`,
  with provenance and source-of-truth reporting in `meta`.
- **Errors are typed values**, not thrown strings, with slash-namespaced codes
  (`routeros/…`, `transport/…`, `validation/…`, `cdb/…`) and a `details_url`
  of the form `https://tikoci.github.io/centrs/errors/<code>` for the
  human-readable explanation.

The load-bearing contract — envelope shape, error model, protocol selection,
settings precedence, and the "done" definition — lives in
`docs/CONSTITUTION.md`. The command×protocol status grid is `docs/MATRIX.md`.

## Repository layout

For contributors. An admin only needs the CLI and their CDB; this is where the
code and authority docs live.

- **`docs/CONSTITUTION.md`** — load-bearing rules (validation, envelope, error
  model, settings precedence, identity/CDB, protocol selection, done).
- **`docs/MATRIX.md`** — command×protocol grid; the only status surface.
- **`commands/<name>/`** — per-command README and executable examples.
- **`src/`** — Bun/TypeScript source.
- **`test/`** — unit and CHR-backed integration tests.

There is no `docs/specs/`, no `work/`, no roadmap doc. The matrix is the
roadmap.

## Development

Requirements:

- Bun 1.3.11 or newer (CI pinned to 1.3.13; Bun 2.x not yet validated).
- Git.
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

## Done definition (short version)

A feature is done when every line in `commands/<name>/examples.md` is green on
real CHR via `bun run test:integration`. Code existing is not done. Unit tests
passing is not done. Full rule:
`.github/instructions/done-definition.instructions.md`.
