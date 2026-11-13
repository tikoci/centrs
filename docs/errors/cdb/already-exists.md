# `cdb/already-exists`

`devices add` refused: a saved device with that target and user already
exists. Nothing was written.

## Emitted by

`devices add`, and the MCP `centrs_devices` tool with `op: add` *(code)*.

## Context

- `target`, `user`: the pair that matched.
- `cdbRecordIndex`: the existing record.

## Fix

- To change the saved device, use `centrs devices set <target>` with the same
  flags. `add` only creates.
- To replace the whole record, pass `--force`. The new record holds only what
  you pass: fields you leave out are not copied from the old one.
- To keep a second login for the same router, add it under a different
  `--user`. Each later command then needs `--match user=<name>` to pick one,
  or it fails as [`identity/ambiguous`](../identity/ambiguous.md).

## Related

- [`identity/ambiguous`](../identity/ambiguous.md)
