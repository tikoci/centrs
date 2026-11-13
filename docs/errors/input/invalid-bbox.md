# `input/invalid-bbox`

A `--bbox` is not four comma-separated numbers in the order south, west,
north, east, with south ≤ north and west ≤ east. Nothing was read or sent.

## Emitted by

`devices list --bbox`, and the `--bbox` selector of fan-out commands
(`retrieve`, `execute`, `api`, `transfer`) *(code)*.

## Context

- `bbox`: the rejected value.

## Typical triggers

- A corner pair in the wrong order, such as north before south:
  `--bbox 37.83,-122.52,37.70,-122.35` *(code)*.
- A box that crosses the antimeridian (west > east). It is not supported:
  split it into two boxes and run twice *(code)*.

## Fix

Pass `--bbox <south>,<west>,<north>,<east>`, for example
`--bbox 37.70,-122.52,37.83,-122.35`.

## Limits

centrs cannot always tell a longitude-first box, as GeoJSON writes it, from a
latitude-first one. When a longitude is outside ±90, the error is
[`input/invalid-coordinate`](invalid-coordinate.md); when both orders fit the
ranges, the box is accepted and selects the wrong devices. Check the order:
latitude first *(code)*.

## Related

- [`input/invalid-coordinate`](invalid-coordinate.md)
- [`input/invalid-radius`](invalid-radius.md)
