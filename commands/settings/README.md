# settings

Read and write centrs's own settings — the global `centrs.env` preferences and
the `__default__` fallback record — and run first-time setup.

Status: `CHR-passed` for the surface described by `examples.md` (fixture-backed
integration tests — `settings` performs no network IO, so no CHR is needed).
See `docs/MATRIX.md` for the cell state. `settings` is the front-end to the
settings the constitution defines (Settings precedence: the `centrs.env` config
file at tier 2; `__default__` fallback creds): it does not invent new settings,
only edits the ones already specified. The interactive first-time-setup flow
(bare `centrs settings` under a TTY) remains a deferred later slice — see
"Surface" below.

## Why

centrs deliberately has no store of its own for *inventory* — that is the CDB.
But it does have **global, centrs-only preferences** (default output format,
default result limit, MCP toggles, …) that have no per-device home, and a
**`__default__` fallback record** for credentials. Today both are hand-edited
(`centrs.env`, or `devices add __default__`). `settings` makes that ergonomic and
is where onboarding flows steer the user.

(Considered and declined: folding `centrs.env` into the future TikTOML device
format, #137. TikTOML's locked scope is inventory — devices/groups/links,
credential-by-reference — and stays that way; see the research posted on #137
for the reasoning. `centrs.env` stays a standalone file.)

## Scope boundary: which `CENTRS_*` keys `settings` manages

Not every `CENTRS_*` env var belongs to `settings`. Two groups, and the split
matters for what `get`/`set`/`print`/`reset` accept:

1. **Managed — full `settings` support.** Every `CENTRS_*` var that a real
   command currently reads, validated with the same rules the consuming code
   already applies (the shared `parseBoolean`/`parseDuration`, a command's own
   enum, `resolveOptionalIntegerSetting`, …), gets full `get`/`set`/`print`/
   `reset`. This includes both tool-behavior keys (`format`, `max-results`,
   `cdb-file`, `resolve`, `mcp-allow-adhoc`) and keys that also have a
   per-device CDB comment-kv counterpart (`via`, `validate`, `timeout`,
   `port`, `ssh-key`, `insecure`) — an earlier draft of this README tried to
   split those into a second, "unmanaged" tier on the theory that
   `settings` "has no visibility into device context." That theory didn't
   hold up: writing `CENTRS_VIA=ssh` to `centrs.env` is mechanically
   identical to writing `CENTRS_FORMAT=json` — a context-free line write —
   and the existing precedence ladder already places the file **below**
   comment-kv (constitution: tier 2 < tier 3), so a device's own `via=`
   override always wins regardless of how the global default was set.
   There's no real distinction left to justify treating these keys worse.
   See the table below for validation per key, including which ones also
   have a comment-kv form (informational — it doesn't change how `settings`
   treats them).
2. **Refused — must not be written by `settings`.** Credential-shaped or
   self-referential keys. `settings set`/`settings reset` on any of these is
   a hard `settings/reserved-key` error with a remediation pointer:

   | Key | Why refused | Use instead |
   | --- | --- | --- |
   | `CENTRS_PASSWORD`, `CENTRS_USERNAME` | Default credentials belong to the `__default__` CDB record, which routes through the `devices` write layer and is redacted from structured output (constitution: identity and CDB). A parallel copy in a plaintext file is a second source of truth for the same secret, one that is never redacted. | `centrs devices add __default__ --user … --password …` |
   | `CENTRS_CDB_PASSWORD` | This is the CDB's own decryption password. Storing it beside an *encrypted* CDB in a plaintext sibling file defeats the encryption. Security-sensitive surface per `SECURITY.md`. | Pass `--cdb-password` per invocation, export the env var in the calling shell, or use `Bun.secret()` once available — never persist to `centrs.env`. |
   | `CENTRS_SKIP_ENV_FILE` | Self-referential: it means "don't load `centrs.env`." Writing it *into* `centrs.env` is a no-op by construction (a file that says "ignore me" is never read to find out). | Export it in the shell or pass `--skip-env-file` per call. |
   | `CENTRS_RUN_FAST_INTEGRATION` | A CI/test signal, not a user preference. | N/A — set by `bun run test:integration`, never by a human. |

   `settings get`/`settings print` on a refused key still works as read-only
   inspection, **except the value itself**: `CENTRS_PASSWORD` and
   `CENTRS_CDB_PASSWORD` are always shown as `"(redacted)"` (with an `isSet`
   boolean instead of the value) regardless of whether the real secret came
   from the process environment or — despite `set` refusing to write it —
   was hand-added to the file directly. `settings` cannot stop a human from
   editing `centrs.env` with a text editor, so the redaction has to be a
   read-time defense, not just a write-time refusal. `CENTRS_USERNAME` is
   refused-on-write (it belongs on the `__default__` record, not for secrecy
   reasons) but is not secret and is shown in full on read.

## Known settings keys

| Key | Type | Built-in default | Comment-kv counterpart? | Notes |
| --- | --- | --- | --- | --- |
| `CENTRS_FORMAT` | enum: `text`\|`json`\|`yaml` | Varies **per command** (`api` defaults `json`; `retrieve`/`execute`/`transfer` default `text`) | No | See "Precedence and what `print`/`get` can actually report" below — `print` cannot show one universal current format. |
| `CENTRS_CDB_FILE` | path | `~/.config/tikoci/winbox.cdb` (`defaultCdbPath`) | No | Existence is not checked at `settings set` time — pre-configuring a path before the file exists is valid. |
| `CENTRS_MAX_RESULTS` | positive integer | command-specific (`retrieve`, `execute`) | No | `settings/invalid-integer` on a non-positive or non-integer value (`resolveOptionalIntegerSetting` rules). |
| `CENTRS_RESOLVE` | enum: `none`\|`arp` | `none` | No | Governs MAC→IP fallback resolution (`src/resolver/mac.ts`, `parseResolvePolicy`). |
| `CENTRS_MCP_ALLOW_ADHOC` | boolean | `false` | No | Currently gates a **not-yet-built** MCP feature (`src/mcp/config.ts` docstring: "reserved for future work, not yet honored"). Safe to expose in `settings` ahead of the feature — `print` should annotate it `(reserved, not yet active)`. **Its reader checks only the literal string `"1"`** (`test/unit/mcp-config.test.ts`: `"true"` → false), not the shared boolean parser — see the canonicalization rule below. |
| `CENTRS_VIA` | enum: `rest-api`\|`native-api`\|`ssh`\|`snmp`\|`mndp`\|`mac-telnet`\|`romon`\|`winbox-terminal` | `rest-api` (per `retrieve`; other commands vary the same way `format` does) | Yes — `via=` | `settings/invalid-via` on an unrecognized value. |
| `CENTRS_VALIDATE` | boolean | `true` | Yes — `validate=` | `settings/invalid-boolean`. |
| `CENTRS_TIMEOUT` | duration (`500ms`, `5s`, `1m`, or bare ms) | command-specific | Yes — `timeout=` | `settings/invalid-timeout` (`parseDuration` rules). |
| `CENTRS_PORT` | positive integer | protocol-default (no built-in default; unset falls through to the transport's own port) | Yes — `port=` | `settings/invalid-integer`. |
| `CENTRS_SSH_KEY` | path | unset | Yes — `ssh-key=` | Path only, never key material — matches the per-device form's own rule. Non-blank check only; existence isn't checked at set time. |
| `CENTRS_INSECURE` | boolean | `false` | Yes — `insecure=` | Accept RouterOS's self-signed TLS cert. `settings set` should still surface a one-line reminder of what it does (`meta.warnings`), since it's a security-relevant toggle even though it's fully validated like any other boolean key. |
| `CENTRS_TRANSFER_VIA` | enum: `auto`\|`rest`/`rest-api`\|`native`/`native-api`\|`sftp`\|`scp`\|`fetch`\|`ftp` | `auto` | **No** — `transfer` reads only the env var (`src/transfer.ts`, `selectTransferMethod`); there is no `transfer-via=` comment-kv key today. | `scp`/`fetch` currently error `not-implemented`; `ftp` is blocked unless `ALLOW_UNSAFE_PROTOCOLS` opts in — `settings set transfer-via ftp` should surface that same warning rather than silently accepting a value that will fail at call time. |
| `CENTRS_HOST` | string | unset (falls back to the target positional) | No (comment-kv has `target`/lookup keys, not a `host` override) | An unusual thing to default globally — most calls pass an explicit target — but it's a real, coded env var, so `settings` exposes it rather than editorializing. Non-blank check only. |

**Boolean write canonicalization:** `settings set <bool-key> <value>` accepts
any spelling the shared `parseBoolean` recognizes (`true`/`false`, `yes`/`no`,
`on`/`off`, `1`/`0`) as *input*, but always **writes the canonical `1` or
`0`** to the file, never `true`/`false`. This is driven by
`CENTRS_MCP_ALLOW_ADHOC`'s strict `=== "1"` reader (a locked, tested
behavior — changing it is out of scope here) — writing `1`/`0` uniformly
satisfies that reader *and* is valid input to every `parseBoolean`-based
reader, so one write rule works for both without touching `mcp/config.ts` or
its test.

*Devices/README.md note:* its comment-kv override-key table does not
currently list `insecure`, even though `commentKvAllowlist`
(`src/resolver/comment-kv.ts`) does. That's a pre-existing doc/code drift in
`devices`' own spec, unrelated to `settings` — flagging it here since this
research surfaced it, not fixing it in this file.

### Not yet wired — exclude from v1

`CENTRS_CONCURRENCY`, `CENTRS_DISCOVER_TIMEOUT`, and `CENTRS_CHECK_IGNORE` are
named in this file's earlier prose and in the constitution's example list, but
**no command in `src/` currently reads them**:

- Fan-out concurrency is `--concurrency` plus a hardcoded transport-aware
  default (REST 8, native-api 4) — there is no env var read anywhere in
  `src/*-fanout.ts`.
- `discover` reads only `--timeout` / `DISCOVER_DEFAULT_TIMEOUT_MS` — no
  `CENTRS_DISCOVER_TIMEOUT` read exists.
- `CENTRS_CHECK_IGNORE` belongs to `check`, which is itself only `designed`
  (not coded).

Shipping `settings set concurrency 8` today would silently do nothing —
succeed, persist a line, and never affect a single fan-out call. That's a
worse UX than not offering the key. **Recommendation: drop these three from
the v1 `settings` vocabulary entirely** (not even `get`-able) until the
consuming command actually reads the env var; add them back to the table
above in the same change that wires the read. This is a real prerequisite,
not a documentation nit — pursuing it here would either ship a lying command
or block #135 on unrelated fan-out/discover changes.

## Surface

```text
centrs settings                                # interactive setup (TTY)
centrs settings print [<attr>] [--all] [--cdb-file <path>] [--cdb-password <pw>]
centrs settings get <attr>                     # read one value
centrs settings set <attr> <value>             # write one value to centrs.env
centrs settings reset [<attr>]                 # clear one/all back to built-in default
```

- **Interactive (`centrs settings`, TTY) — deferred later slice, not built.**
  Eventually: prompts (clack-style, like `@tikoci/quickchr`) to optionally
  collect a default `user`/`password` (written to the `__default__` record so
  a fresh CDB "starts useful"), confirm/update global preferences, and report
  where the `centrs.env` lives. **Implementation prerequisite:** centrs has no
  prompt-library dependency today (`package.json` lists only `zod` and the MCP
  SDK) — this slice needs one added (`@clack/prompts`, matching the
  `@tikoci/quickchr` reference). Until it ships, bare `centrs settings`
  behaves identically to `settings print` **regardless of TTY** — matching
  the issue's own phasing, which explicitly said not to block the
  non-interactive surface (built below) on this later slice.
- **Non-interactive (`set`/`get`/`reset`/`print`):** scriptable edits to
  `centrs.env`. Exit code `0` on success, `1` on a validation/refusal error —
  matching the plain (non-fan-out) CLI error convention already used
  elsewhere (`src/cli/api.ts`'s `exitCode`), never a bare non-zero without an
  envelope. `settings` has no fan-out surface, so the constitution's `2`
  ("partial" fan-out result) never applies here.
- **Agent-facing:** every subcommand emits the standard envelope
  (`ok`/`data`/`meta`/`error`) regardless of TTY — `--format json` is
  honored on `settings` itself exactly like every other command, so an agent
  never needs a TTY-detection special case to consume it.
- **`--cdb-file <path>` / `--cdb-password <pw>`** (on `print` only): scope
  which CDB `print` probes for the `__default__` record summary (see
  "`__default__` boundary" in the examples). These are **not** settings
  precedence sources — they don't participate in the `default`/`config`/`env`
  vocabulary below, because they're not resolving a `CENTRS_*` value at all;
  they're a one-off read of a different file, reported alongside settings.
  Absent, they fall back to the normal `CENTRS_CDB_FILE`/`CENTRS_CDB_PASSWORD`
  resolution (built-in path / env — never `centrs.env`, since `CDB_PASSWORD`
  is refused there).
- Credentials collected for `__default__` route through the `devices` write
  layer (the only CDB writer) and are redacted from any structured output.

### `--all`

`print`'s default view lists only the keys `settings` recognizes (the table
above). `--all` additionally lists every other `CENTRS_*=` line literally
present in the file — a foreign var a user added for their own shell use, a
typo of a real key, or (redacted) a refused credential key someone hand-added
despite `set` refusing to write it — each tagged `(unrecognized)`. This keeps
the default output focused on what `settings` actually understands while
still making `print --all` the honest "what's actually in this file" dump for
debugging.

## Boundaries

- `settings` edits **global** preferences (`centrs.env`) and the **`__default__`**
  record only. Per-device settings stay in `devices` (CDB comment-kv).
- It writes no RouterOS device; it is local-only, like `devices`.
- `--skip-env-file` / `CENTRS_SKIP_ENV_FILE=1` makes a run ignore `centrs.env`
  **for every other command's precedence resolution**. It does not affect
  `settings` itself: `settings` always reads and writes the real file
  regardless of this flag, since inspecting/editing the file *is* its job. A
  `settings print` run under `--skip-env-file` should still show the file's
  contents, with a one-line note that the flag is active and other commands
  in this same invocation environment would not see them.

## Onboarding

`settings` is the steering target for "centrs starts useful": an empty CDB plus a
first `retrieve`/`devices` should tip toward `centrs settings` (collect default
creds) and `centrs devices discover` (populate the registry). See
`commands/discover/README.md` (save-implied `devices discover`) and
`docs/CONSTITUTION.md` (Default-device record).

## Settings keys: file format and write strategy

`centrs.env` holds **canonical `CENTRS_*=value` lines** — identical to the
environment-variable spellings, prefix included (`CENTRS_FORMAT=json`,
`CENTRS_MAX_RESULTS=500`). One vocabulary across file / env / CLI: the file
*is* "just default env vars," so `set -a && source centrs.env` works and the
loader applies each key as a default **only when the same `CENTRS_*` is not
already in the process environment** (it never injects into `process.env`).
`settings set <attr>` accepts the setting name with or without the prefix, and
in kebab-case or SCREAMING_SNAKE (`format`, `FORMAT`, `centrs_format`,
`CENTRS_FORMAT` all resolve to the same key), but always **writes** the
canonical `CENTRS_FORMAT=` line. It is **user-global only** — the single XDG
path above; there is no project-local config file discovered from the working
directory.

**The `config` precedence layer** — `src/resolver/config-file.ts` resolves
`${XDG_CONFIG_HOME:-~/.config}/tikoci/centrs.env` (injectable `env` map,
mirroring `defaultCdbPath`) and `loadEnvFileDefaults()` parses it into a flat
`Record<string, string>`. `resolveStringSetting`/`resolveBooleanSetting`/
`resolveOptionalIntegerSetting` (`src/resolver/settings.ts`) each take this as
a `config` argument, checked *between* `comment-kv` and the built-in default,
producing `{ value, source: { kind: "config", key: "CENTRS_FORMAT" } }` — a
genuine new layer, not a value folded into the existing `defaultValue`
parameter (which would have reported it with `source: "default"`, losing
provenance). Every command that resolves a managed key (`retrieve`, `execute`,
`api`, `transfer`, `terminal`, plus `resolveCdb`/`expandCdbSelection` for
`CENTRS_CDB_FILE` and `mcp/config.ts` for `CENTRS_CDB_FILE`/
`CENTRS_MCP_ALLOW_ADHOC`) threads this `config` argument through, so a value
set via `centrs settings set` actually takes effect everywhere, not just in
`settings print`'s own report. `CENTRS_USERNAME`/`CENTRS_PASSWORD`/
`CENTRS_CDB_PASSWORD` deliberately never read this tier, even if hand-added to
the file — a stronger defense than read-time redaction alone, since a
hand-edited credential line then cannot function as a live source. Fan-out
via-pinning guards (`retrieve`/`execute`/`api`) also deliberately exclude
`config` — a `centrs.env` default is the weakest precedence tier and must not
override a per-device comment-kv `via=` across a mixed fan-out.

Write strategy (new; the current file is silent on this):

- **Preserve unrecognized content.** A hand-edited `centrs.env` may carry
  blank lines, `#` comments, or foreign (non-`CENTRS_*`) lines. `set`/`reset`
  parse-modify-write, touching only the matched line; everything else
  round-trips byte-for-byte, mirroring the CDB's "unknown fields preserved
  verbatim" principle (`commands/devices/README.md`).
- **`reset <attr>` deletes the line, never blanks it.** A blank
  `CENTRS_FORMAT=` line is *not* equivalent to "unset" for a file meant to be
  bash-`source`-able — sourcing it would set the shell variable to an empty
  string, which most shells and centrs's own `env[KEY] !== undefined` check
  both treat as "set." Deleting the line entirely is the only way `reset`
  actually restores the built-in default. (This is the one place `settings`
  must **not** copy the CDB comment-kv convention, where an empty value
  removes the token — that convention is safe there because centrs parses
  comment-kv itself; it would be a correctness bug here.)
- **`reset` with no `<attr>` removes every managed-key line** this file
  currently holds, leaving unrecognized lines and all comments/blank lines
  untouched, and reports `data.cleared: [...]` listing what it removed. No
  confirmation gate — the blast radius is one local file, not N routers, and
  every value is recoverable by re-running `settings set`.
- **Atomic write:** write to a temp file in the same directory, `fsync`, then
  `rename()` over the original — same pattern as the CDB write layer, scaled
  down (a single `.bak` copy is enough; this file has no multi-KB record set
  to protect, and a user can always re-type a couple of lines, but a crash
  mid-write must never corrupt a file other shells `source`).
- **First write creates the directory.** `${XDG_CONFIG_HOME:-~/.config}/tikoci/`
  may not exist yet on a fresh machine; `set` creates it (and the file) rather
  than erroring.

## Precedence and what `print`/`get` can actually report

The constitution's five-tier precedence (`default < config < comment-kv < env
< cli`) is a **per-call** resolution — it needs a specific command invocation
(which CDB record matched, which CLI flags were passed) to produce a `cli` or
`cdb`/`comment-kv` source. A bare `centrs settings print` has no such call
context: there is no target, no command, no CLI flags being resolved. So for
each key, `print`/`get` can only ever report one of three sources —
`default` (built-in, nothing set), `config` (this file has a line for it —
the same `SettingSourceKind` every other command's `meta.settings` will use
once the loader above exists), or `env` (the real process environment
currently has the var set, which would shadow whatever the file says). It
should **not** claim `cli` or `comment-kv` sources — those require a call
`settings` never makes.

For `CENTRS_FORMAT` specifically: because each command defines its own
built-in default (`api`: `json`; others: `text`) independently
(`retrieveOutputFormats`/`apiOutputFormats`/`executeOutputFormats`/
`transferOutputFormats` are four separate `const` arrays that currently all
happen to agree on the same three values), `print` should show the
`config`/`env` value if set, and when unset show **all** per-command
defaults rather than a single misleading "default: text" — e.g. `default:
text (api: json)`.

## Testability

`settings` is fixture-testable the same way `devices` is: `defaultSettingsPath`
(`src/resolver/config-file.ts`) takes an injectable
`env: Record<string, string | undefined>` map and reads `XDG_CONFIG_HOME`
from it (falling back to `HOME`, then `os.homedir()`) — mirroring
`defaultCdbPath`'s pattern. `test/integration/settings.test.ts` sets
`XDG_CONFIG_HOME` to a per-test temp directory (exactly like `$CDB` in the
`devices` fixtures), so no test ever touches a real user's
`~/.config/tikoci/centrs.env`.

## Error and warning codes

Per the contributor contract in `docs/errors/README.md`, every code below has
a catalog entry (`src/core/error-catalog.ts`) and a `docs/errors/<code>.md`
page:

- `settings/reserved-key` — `set`/`reset` refused a credential or
  self-referential key (see Scope boundary table).
- `settings/unknown-key` — `get`/`set` received a token that is not a
  recognized `CENTRS_*`-shaped name at all — e.g. a typo. (Not needed for
  reads via `print --all`, which tags-and-shows rather than rejecting.)
- `settings/consequential-value` — a non-fatal `set` warning (resolves the
  former open question below) for exactly two keys: `insecure=true` and
  `transfer-via=ftp`. `meta.warnings`, not an interactive confirm — a confirm
  prompt in non-TTY mode isn't meaningful and would break scripting.
- `settings/skip-env-file-active` — a non-fatal `print` warning noting that
  `--skip-env-file` is active for this invocation only; `settings` itself
  always reads the real file regardless.
- `internal/settings-failed` — generic internal-error fallback, left as an
  unenriched stub matching the sibling `internal/devices-failed`.
- `settings/invalid-boolean`, `settings/invalid-integer`,
  `settings/invalid-timeout`, `settings/invalid-via`, `settings/invalid-format`,
  `settings/unsafe-protocol-blocked` (referenced by the `consequential-value`
  warning for `transfer-via=ftp`) already existed in the catalog (shared with
  other commands' resolvers) and apply unchanged here.
