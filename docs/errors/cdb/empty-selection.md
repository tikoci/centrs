# `cdb/empty-selection`

The target selection matched no CDB records.

## Fix

A fan-out selection involving `--where` / `--all` / `--default` / positionals (on
its own or mixed with `--group`) resolved to zero targets. This is reported as a
warning on an `ok: true` fan-out envelope with `summary { total: 0, ok: 0, failed:
0 }`, not a hard failure — there was simply nothing to run.

A **group-only** empty (bare `--group`, no other selector) is reported as
[`cdb/empty-group`](empty-group.md) instead, naming the group that matched nothing;
this page covers every other empty selection.

Check the selector: run `centrs devices list` (and `centrs devices groups`) to see
the registered records, groups, and the facts a `--where <attr>=<value>` can match.
See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) (Target selection) for the
selector grammar.
