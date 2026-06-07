# config

Read and write centrs's own settings — the global `centrs.env` preferences and
the `__default__` fallback record — and run first-time setup.

Status: `designed`. This file describes intent and flags; no implementation yet.
See `docs/MATRIX.md` for the cell state. `config` is the front-end to the
settings the constitution defines (Settings precedence: the `centrs.env` config
file at tier 2; `__default__` fallback creds): it does not invent new settings,
only edits the ones already specified.

## Why

centrs deliberately has no store of its own for *inventory* — that is the CDB.
But it does have **global, centrs-only preferences** (default discovery window,
default `--format`, concurrency, …) that have no per-device home, and a
**`__default__` fallback record** for credentials. Today both are hand-edited
(`centrs.env`, or `devices add __default__`). `config` makes that ergonomic and
is where onboarding flows steer the user.

## Surface

```text
centrs config                                  # interactive setup (TTY)
centrs config print [<attr>]                   # show resolved settings + sources
centrs config get <attr>                       # read one value
centrs config set <attr> <value>               # write one value to centrs.env
centrs config reset [<attr>]                   # clear one/all back to built-in default
```

- **Interactive (`centrs config`, TTY):** prompts (clack-style, like
  `@tikoci/quickchr`) to optionally collect a default `user`/`password` (written
  to the `__default__` record so a fresh CDB "starts useful"), confirm/update
  global preferences, and report where the `centrs.env` lives. Non-TTY runs of
  bare `config` print the resolved settings instead of prompting.
- **Non-interactive (`set`/`get`/`reset`/`print`):** scriptable edits to
  `centrs.env`. `print` shows each resolved setting with its winning source
  (`default` / `centrs.env` / `env` / `cli`), mirroring `meta.settings`.
- Credentials collected for `__default__` route through the `devices` write
  layer (the only CDB writer) and are redacted from any structured output.

## Boundaries

- `config` edits **global** preferences (`centrs.env`) and the **`__default__`**
  record only. Per-device settings stay in `devices` (CDB comment-kv).
- It writes no RouterOS device; it is local-only, like `devices`.
- `--skip-env-file` / `CENTRS_SKIP_ENV_FILE=1` makes a run ignore `centrs.env`
  (tests, dev-agent usage); `config` still reports what *would* apply.

## Onboarding

`config` is the steering target for "centrs starts useful": an empty CDB plus a
first `retrieve`/`devices` should tip toward `centrs config` (collect default
creds) and `centrs devices discover` (populate the registry). See
`commands/discover/README.md` (save-implied `devices discover`) and
`docs/CONSTITUTION.md` (Default-device record).

## Settings keys

`centrs.env` holds **canonical `CENTRS_*=value` lines** — identical to the
environment-variable spellings, prefix included (`CENTRS_FORMAT=json`,
`CENTRS_DISCOVER_TIMEOUT=15s`, `CENTRS_CONCURRENCY=8`). One vocabulary across
file / env / CLI: the file *is* "just default env vars," so `set -a && source
centrs.env` works and the loader applies each key as a default **only when the
same `CENTRS_*` is not already in the process environment** (it never injects
into `process.env`). `config set <attr>` accepts the setting name with or
without the prefix for convenience but always writes the canonical prefixed
line. It is **user-global only** — the single XDG path above; there is no
project-local config file discovered from the working directory.
