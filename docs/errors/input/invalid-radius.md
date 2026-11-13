# `input/invalid-radius`

A `--near` radius is not a non-negative number with an optional unit.
Nothing was read or sent.

## Emitted by

`devices list --near`, and the `--near` selector of fan-out commands *(code)*.

## Context

- `value`: the rejected radius.

## Fix

Pass the radius as a number with `m`, `km`, `mi` or `ft`, for example `50km`
or `500m`. A bare number is kilometers.

## Related

- [`input/invalid-coordinate`](invalid-coordinate.md): the center point.
- [`input/invalid-bbox`](invalid-bbox.md)
