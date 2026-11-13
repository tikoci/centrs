# `usage/target-exists`

The destination file or directory already exists on the router, and centrs
does not overwrite without `--force`. Nothing was changed.

## Emitted by

`transfer upload`, `copy` and `mkdir` *(code)*.

## Context

- `remote`: the existing path.

## Fix

- To replace it, pass `--force`.
- Otherwise choose another name. `centrs transfer <router> list` shows the
  router's files.

## Related

- [`input/local-file-not-found`](../input/local-file-not-found.md)
