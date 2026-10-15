# `cdb/empty-selection`

The target selection matched no CDB records.

## Fix

A fan-out selection involving `--where` / `--all` / `--default` / positionals (on
its own or mixed with `--group`) resolved to zero targets.

- For a **read**, it is a warning on an `ok: true` fan-out envelope with
  `summary { total: 0, ok: 0, failed: 0 }` and exit code 0: there was simply
  nothing to read.
- For a **write-shaped** fan-out (`execute` write, a mutating `api` method,
  `transfer upload|remove|mkdir|copy`) it is an outer error (`ok: false`, exit
  code 1), with or without `--yes`, so a mistyped selector does not look like
  a successful bulk write. `context.write` is `true`.

A **group-only** empty (bare `--group`, no other selector) is reported as
[`cdb/empty-group`](empty-group.md) instead, naming the group that matched nothing;
this page covers every other empty selection.

Check the selector: run `centrs devices list` (and `centrs devices groups`) to see
the registered records, groups, and the facts a `--where <attr>=<value>` can match.
See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) (Target selection) for the
selector grammar.
