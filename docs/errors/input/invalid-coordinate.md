# `input/invalid-coordinate`

A latitude or longitude is not a decimal-degrees number in range: latitude
in [-90, 90], longitude in [-180, 180]. Nothing was written or sent.

## Emitted by

`devices add` and `set` (`--lat`, `--lon`, `--gps`), and the `--near` and
`--bbox` selectors *(code)*.

## Context

- `key`: `lat` or `lon`.
- `value`: the rejected value.

## Typical triggers

- Swapped coordinates: a longitude such as `-122.4` given as the latitude
  *(code)*.
- Degrees-minutes-seconds (`37°46'N`) instead of decimal degrees *(code)*.

## Fix

Pass decimal degrees, latitude first: `--lat 37.7749 --lon -122.4194`.

## Related

- [`input/incomplete-gps`](incomplete-gps.md)
- [`input/invalid-bbox`](invalid-bbox.md)
