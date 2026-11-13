# `cdb/invalid-option`

A warning: a device property, or a `--via` or `CENTRS_VIA` value, is one
centrs cannot use, such as `via=foo` or `port=abc`. centrs ignores it, and the
setting comes from the next source: an environment variable, the config file,
or the default.

## Context

- `key`, `value`: the setting and its value. `key` is the device property
  (`via`, `port`, ...), or `--via` or `CENTRS_VIA` when `devices show` checked
  the flag or the environment.
- `recordIndex`: the device record.

## Fix

Correct or remove the source `key` names:

- A device property: set a valid value with
  `centrs devices set <router> <key>=<value>`, or remove it with `<key>=` (no
  value).
- `--via`: pass a supported protocol, or drop the flag.
- `CENTRS_VIA`: set a supported protocol, or unset it.

To see what a command uses, run it with `--json`: `meta.target` holds the
resolved address and port, and `meta.settings` says where each setting came
from. `devices show` reads properties more loosely
than the command resolver (it shows `validate=foo` as true, for example), so
it is not a check of what a command will use.

## Related

- [`cdb/unknown-option`](unknown-option.md): a key that is not a device
  property at all.
