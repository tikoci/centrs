# `usage/timeout-out-of-range`

The `--timeout` is longer than REST allows. Nothing was sent.

## Emitted by

`retrieve`, `execute`, `api` and `transfer` over REST *(code)*.

## Context

- `via`, `timeoutMs`, `ceilingMs`: the transport, the requested timeout and
  the 60,000 ms ceiling.

## Why

RouterOS ends a REST request at about 60 seconds, whatever the client waits
for, so a longer timeout over REST would never be used.

## Fix

- Use `--timeout 60s` or less.
- For a longer command, use `--via native-api`, which has no such ceiling.
  Some RouterOS commands still stop on their own at about 60 seconds; the
  [`execute` README](../../../commands/execute/README.md) lists them.

## Related

- [`input/max-results-exceeded`](../input/max-results-exceeded.md)
