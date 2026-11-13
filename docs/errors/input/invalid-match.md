# `input/invalid-match`

A `--match` value is not a selector centrs knows. Nothing was changed, and no
router was contacted.

## Context

- `target`: the `<router>` being narrowed.
- `match`: the rejected selector.

## Fix

`--match` takes one of:

- `user=<name>`: the record with that user.
- `target=<address>`: the record with that target.
- A record type: `ipAdmin`, `ipUser`, `macTarget` and the other names in
  `remediation`.

Any other `key=` is refused. To select devices by a property, use `--where`
on a fan-out instead.

## Related

- [`identity/ambiguous`](../identity/ambiguous.md): why `--match` is needed.
- [`identity/no-match`](../identity/no-match.md): a valid selector that
  matched nothing.
