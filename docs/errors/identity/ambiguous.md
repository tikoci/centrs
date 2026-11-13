# `identity/ambiguous`

`<router>` matches more than one saved device, and centrs will not guess
which one you meant. Nothing was changed, and no router was contacted.

## Context

- `target`: the `<router>` string.
- `matches`: each candidate's `cdbRecordIndex`, `target`, `user` and
  `recordType`.

## Typical triggers

- The same address saved twice with different users, which WinBox allows: two
  records for `10.9.9.1`, one for `admin` and one for `ops` *(code;
  reproduced with a scratch CDB)*.
- One name shared by several devices, through the same `identity=` property
  or the same target *(code)*.

## Fix

- On a single target, pick one record with `--match`: `--match user=<name>`,
  `--match target=<addr>`, or a record type (`--match ipAdmin`).
- In a fan-out, `--match` is refused. Run that target on its own with
  `--match`, or select it with `--group` or `--where`.
- Over MCP, which has no `--match`, pass one candidate's address from
  `context.matches[].target`. This works only when the candidates have
  different addresses. When they share one, as in the same-address case above,
  remove the duplicate with the CLI first, then retry over MCP.
- To remove the duplicate for good: `centrs devices remove <router> --match …`.

## Related

- [`identity/no-match`](no-match.md): `--match` excluded every candidate.
- [`cdb/not-found-target`](../cdb/not-found-target.md)
