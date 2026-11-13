# `routeros/protocol-not-implemented`

The command does not run over the requested `--via` protocol yet, so centrs
refused it before connecting. Nothing was sent.

## Emitted by

- `retrieve --via snmp` *(code)*.
- `execute --via romon` and `execute --via winbox-terminal` *(code)*.
- `api` with any `--via` other than `rest-api` or `native-api`, such as
  `ssh` or `mac-telnet` *(code)*. Here the pairing is not planned at all:
  `api` is a structured passthrough, and console transports run commands
  through `execute` and `terminal`.

## Context

- `via`: the protocol asked for.
- `capability`: the capability it was checked for (`api` reports `execute`).

## Fix

Use a transport the command supports. `retrieve` and `api` run over
`rest-api` or `native-api`; `execute` runs over those two, `ssh` and
`mac-telnet`. The [protocol matrix](../../MATRIX.md) says what is built. If
the `--via` came from `CENTRS_VIA` or the device's saved `via=` property,
override it with an explicit `--via`.

## Related

- [`routeros/unsupported-capability`](unsupported-capability.md): the
  protocol cannot do this at all.
- [`usage/not-implemented`](../usage/not-implemented.md): a flag or mode that
  is not built.
