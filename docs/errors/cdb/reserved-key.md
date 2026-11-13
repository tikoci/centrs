# `cdb/reserved-key`

`devices add` or `set` was given `key=value` for a field that has its own
flag: `user`, `password`, `group`, `profile` or `session`. Nothing was
written.

## Context

- `target`: the device.
- `reservedKeys`: the keys refused.

## Fix

Use the flag instead:

| Key | Flag |
| --- | --- |
| `user` | `--user` |
| `password` | `--password-stdin` or `--password` |
| `group` | `--group` |
| `profile` | `--profile`, `--profile-none` or `--profile-own` |
| `session` | `--session` |

`password=` with no value is refused too. To clear the stored password, pass
`--password ""`.

## Related

- [`cdb/reserved-option`](reserved-option.md): the same keys found on a saved
  device.
- [`cdb/unknown-option`](unknown-option.md): a key that is not a device
  property at all.
