# `cdb/empty-group`

The named CDB group contains no records.

## Typical trigger

A fan-out selected only by `--group` (no other selector) whose group matched
no record: a misspelled or case-mismatched group name, or a group whose last
member was removed.

- For a **read**, it is a warning on an `ok: true` fan-out envelope with
  `summary { total: 0, ok: 0, failed: 0 }` and exit code 0.
- For a **write-shaped** fan-out (`execute` write, a mutating `api` method,
  `transfer upload|remove|mkdir|copy`) it is an outer error (`ok: false`, exit
  code 1), with or without `--yes`. `context.write` is `true`.

Any other empty selection (`--where`, `--all`, positionals, mixed) is
[`cdb/empty-selection`](empty-selection.md).

## Fix

Run `centrs devices groups` to see the groups that exist and their member
counts, then re-run with the right name. See
[`docs/CONSTITUTION.md`](../../CONSTITUTION.md) (Target selection) for the
selector grammar.
