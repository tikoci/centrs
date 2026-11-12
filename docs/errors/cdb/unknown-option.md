# `cdb/unknown-option`

A `key=value` given to `devices add` or `devices set`, or found on a saved
device, is not a centrs device property. centrs keeps it but it has no
effect. With `--strict`, `devices add` and `set` refuse to write it instead.

Device properties are centrs's own settings for reaching a device, such as
`via`, `port`, `ssh-key` or `identity`. They are not RouterOS settings:
`devices set` never changes anything on the router.

## Context

- `key`: the key that is not a device property.
- `target`: the device, on `devices add` and `set`.

## Typical triggers

- An agent tried to set a router setting through `devices set`, such as
  `centrs devices set edge1 note=…` *(field)*. `note` is not a device
  property, so nothing on the router changed.
- A misspelled property, such as `ssh_key=` for `ssh-key=` *(code)*.

## Fix

- To change the router, run the RouterOS command with `execute`, for example
  `centrs execute edge1 '/system/note set note="rack 7"' --yes`.
- To change how centrs reaches the device, use a device property: `via`,
  `validate`, `timeout`, `port`, `www-port`, `www-ssl-port`, `api-port`,
  `api-ssl-port`, `ssh-port`, `ssh-key`, `insecure`, `source`, `mcp`; the
  lookup keys `identity`, `mac` and `ip`; and `lat`, `lon`, `altitude`,
  `altitude-type`. User, password, group, profile and session have their own
  flags.
- To remove the key: `centrs devices set <router> <key>=`.

## Related

- [`cdb/reserved-option`](reserved-option.md): a key that has its own flag.
- [`cdb/reserved-key`](reserved-key.md)
