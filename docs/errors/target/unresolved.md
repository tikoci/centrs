# `target/unresolved`

centrs found no host to connect to. Nothing was sent to that target.

## Emitted by

- A fan-out (`retrieve`, `execute`, `api`, `transfer`) whose selection
  includes the `__default__` record *(code)*. Only that member fails: the
  other selected targets still run, so a write may already have been applied
  on them. Check each one's result in the envelope.
- Library callers that pass no target and no `host` *(code)*. On the CLI a
  missing target stops earlier, as
  [`input/invalid-command`](../input/invalid-command.md).

## Context

- `target`, or `targetInput`: what was asked for.

## Typical triggers

- `--default` used as the target. `__default__` holds fallback credentials
  for devices with none of their own; it is not a router *(code)*.
- `--host` or `CENTRS_HOST` set to an empty string *(code)*. It outranks the
  target, so passing a target does not help; the summary names which one.

## Fix

- Select real devices: a positional, `--group`, `--where` or `--all`.
- Set the empty `--host` or `CENTRS_HOST` to an address, or unset it.
- Library callers: pass a target or `host`.

## Related

- [`cdb/not-found-target`](../cdb/not-found-target.md)
- [`target/mac-unresolved`](mac-unresolved.md)
