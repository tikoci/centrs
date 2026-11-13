# `identity/no-match`

`--match` was given, but no saved device for `<router>` fits it. Nothing was
changed, and no router was contacted.

## Context

- `target`: the `<router>` string.
- `match`: the `--match` value.
- `matches`: the candidates that do exist for `<router>`, when there are any.

## Typical triggers

- A `--match user=` naming a user no record for that target has *(code;
  reproduced with a scratch CDB)*.
- `--match` on a `<router>` that has no saved device at all. `--match` needs
  a saved device to select from, so the target is not dialed as a literal
  host *(code)*.

## Fix

- Read `context.matches`, or run `centrs devices list`, to see each record's
  user and record type, and pass a `--match` that exists.
- To dial an unsaved address, drop `--match`.

## Related

- [`identity/ambiguous`](ambiguous.md)
- [`input/invalid-match`](../input/invalid-match.md): the `--match` value is
  malformed.
