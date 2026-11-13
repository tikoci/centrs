# `cdb/reserved-option`

A warning: a saved device has `user`, `password`, `group`, `profile` or
`session` written as a `key=value` property. Those are fields of the record,
so centrs ignores the property. The record's real field is used.

## Context

- `key`: the property ignored.

## Typical triggers

The device's comment was edited by hand, in WinBox for example, to include
`user=admin` or `password=…` *(code)*.

## Fix

- Remove the `key=value` from the device's comment in WinBox. `devices set`
  cannot remove it, because it refuses these keys
  ([`cdb/reserved-key`](reserved-key.md)).
- Set the real field with its flag: `centrs devices set <router> --user …`,
  `--password-stdin`, `--group`, `--profile` or `--session`.
- A password in a comment shows to anyone who can see the comment, in WinBox
  for example. Remove it, and change it on the router if others could see
  it.

## Related

- [`cdb/reserved-key`](reserved-key.md)
