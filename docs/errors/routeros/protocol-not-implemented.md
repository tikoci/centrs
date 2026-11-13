# `routeros/protocol-not-implemented`

The command does not run over the requested `--via` protocol yet, so centrs
refused it before connecting. Nothing was sent.

## Emitted by

- `retrieve --via snmp` *(code)*.
- `execute --via romon` and `execute --via winbox-terminal` *(code)*.

`api --via ssh` or `mac-telnet` fails as
[`routeros/unsupported-capability`](unsupported-capability.md) instead: that
pairing is not planned.

## Context

- `via`: the protocol asked for.
- `capability`: the capability it was checked for (`retrieve` or `execute`).

## Fix

Use a transport the command supports. `retrieve` runs over `rest-api` or
`native-api`; `execute` runs over those two, `ssh` and `mac-telnet`. The [protocol matrix](../../MATRIX.md) says what is built. If
the `--via` came from `CENTRS_VIA` or the device's saved `via=` property,
override it with an explicit `--via`.

## Related

- [`routeros/unsupported-capability`](unsupported-capability.md): the
  protocol cannot do this at all.
- [`usage/not-implemented`](../usage/not-implemented.md): a flag or mode that
  is not built.
