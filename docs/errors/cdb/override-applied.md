# `cdb/override-applied`

A warning: the device's saved `via` property was overridden by `--via` or
`CENTRS_VIA`, so this command uses another transport. It is informational:
the higher source wins, as intended.

## Emitted by

`devices show` *(code)*.

## Context

- `target`, `key`: the device and the property (`via`).
- `commentValue`: the saved value.
- `winner`, `source`: the value used and where it came from.

## Fix

Nothing, if you meant to override it. If not, unset `CENTRS_VIA` or drop
`--via`. To change what the device uses by default:
`centrs devices set <router> via=<protocol>`.
