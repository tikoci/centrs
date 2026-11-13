# `input/incomplete-gps`

A device location was given without both coordinates: only `lat` or only
`lon`, or a `--gps` value with fewer than two parts. Nothing was written.

## Emitted by

`devices add` and `set` (`--lat`, `--lon`, `--gps`, or `lat=` and `lon=`)
*(code)*.

## Context

- `target`, `hasLat`, `hasLon`: which half would be missing after the change.
- `gps`: the `--gps` value, when that was the input.

## Typical triggers

- `devices set <router> --lat 37.77` on a device with no saved `lon`
  *(code)*.
- `--gps 37.77` or `--gps 37.77,` *(code)*.

## Fix

Set both at once: `--gps <lat>,<lon>[,<altitude>[,<altitude-type>]]`, for
example `--gps 37.7749,-122.4194`, or pass `--lat` and `--lon` together.

## Related

- [`input/invalid-coordinate`](invalid-coordinate.md)
- [`input/invalid-altitude`](invalid-altitude.md)
