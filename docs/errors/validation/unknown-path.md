# `validation/unknown-path`

The RouterOS path does not exist, or does not expose the requested command.

Two sources raise it:

- **`execute` / `validate`** — RouterOS's `:parse` rejected a path segment, and
  the path is in no published RouterOS 7 build centrs knows of (its path
  catalog covers 7.10–7.25, all extra packages). Usually a typo.
  `error.context.path` is the path through the rejected segment,
  `error.context.segment` the segment as written, and `error.position`
  RouterOS's byte column. A path the catalog does know is reported as
  [`validation/package-missing`](package-missing.md) or
  [`validation/menu-unavailable`](menu-unavailable.md) instead.
- **`retrieve` / `api`** — `/console/inspect` shows the path has no command of
  the kind requested (no `print` or `get` to read with).

## Fix

Check the spelling of the segment in `error.context.segment`. `centrs explain
'<command>'` shows how the rest of the command reads offline.
