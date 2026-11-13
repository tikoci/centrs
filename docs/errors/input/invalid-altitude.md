# `input/invalid-altitude`

An altitude is not a number, or an altitude type is not `MSL` or `AGL`.
Nothing was written.

## Emitted by

`devices add` and `set` (`--altitude`, `--altitude-type`, the third and
fourth parts of `--gps`, or `altitude=` and `altitude-type=`) *(code)*.

## Context

- `key`: `altitude` or `altitude-type`.
- `value`: the rejected value.

## Fix

- Altitude is a number of meters, for example `--altitude 120`. Negative
  values are allowed.
- Altitude type is `MSL` (mean sea level, the default) or `AGL` (above ground
  level), in any case.

## Related

- [`input/incomplete-gps`](incomplete-gps.md)
