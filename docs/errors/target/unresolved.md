# `target/unresolved`

centrs found no host to connect to. Nothing was sent.

## Emitted by

- A fan-out (`retrieve`, `execute`, `api`, `transfer`) whose selection
  includes the `__default__` record *(code)*.
- Library callers that pass no target and no `host` *(code)*. On the CLI a
  missing target stops earlier, as
  [`input/invalid-command`](../input/invalid-command.md).

## Context

- `target`, or `targetInput`: what was asked for.

## Typical triggers

- `--default` used as the target. `__default__` holds fallback credentials
  for devices with none of their own; it is not a router *(code)*.
- `CENTRS_HOST` set to an empty string in a library or test environment
  *(code)*.

## Fix

- Select real devices: a positional, `--group`, `--where` or `--all`.
- Library callers: pass a target or `host`.

## Related

- [`cdb/not-found-target`](../cdb/not-found-target.md)
- [`target/mac-unresolved`](mac-unresolved.md)
