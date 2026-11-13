# `input/invalid-bbox`

A `--bbox` is not four comma-separated numbers in the order south, west,
north, east, with south ≤ north and west ≤ east. Nothing was read or sent.

## Emitted by

`devices list --bbox`, and the `--bbox` selector of fan-out commands
(`retrieve`, `execute`, `api`, `transfer`) *(code)*.

## Context

- `bbox`: the rejected value.

## Typical triggers

- Longitude first, as in GeoJSON: `--bbox -122.52,37.70,-122.35,37.83`. The
  order is latitude first *(code)*.
- A box that crosses the antimeridian (west > east). It is not supported:
  split it into two boxes and run twice *(code)*.

## Fix

Pass `--bbox <south>,<west>,<north>,<east>`, for example
`--bbox 37.70,-122.52,37.83,-122.35`.

## Related

- [`input/invalid-coordinate`](invalid-coordinate.md)
- [`input/invalid-radius`](invalid-radius.md)
