# `routeros/unsupported-capability`

The `--via` protocol cannot do what the command needs, so centrs refused it
before connecting. Nothing was sent.

## Emitted by

- `retrieve` with `--via ssh`, `mac-telnet`, `mndp`, `romon` or
  `winbox-terminal` *(code)*. `retrieve --via snmp` fails as
  [`routeros/protocol-not-implemented`](protocol-not-implemented.md) instead,
  and `retrieve --via btest` as
  [`settings/invalid-via`](../settings/invalid-via.md).
- `execute` with `--via snmp`, `mndp` or `btest` *(code)*.
- `api` with any `--via` other than `rest-api` or `native-api`, such as `ssh`
  or `mac-telnet` *(code)*. `api` is a structured passthrough, and the console
  transports run commands through `execute` and `terminal`.

## Context

- `via`: the protocol asked for.
- `capability`: what the command needed (`retrieve`, `execute` or `api`).

## Fix

Pick a transport that has the capability. `retrieve` and `api` run over
`rest-api` or `native-api`; `execute` runs over those two, `ssh` and
`mac-telnet`. To run a console command over `ssh` or `mac-telnet`, use
`centrs execute <router> --via ssh -- '<command>'`. The
[protocol matrix](../../MATRIX.md) lists every cell. If the `--via` came from
`CENTRS_VIA` or the device's saved `via=` property, override it with an
explicit `--via`.

## Related

- [`routeros/protocol-not-implemented`](protocol-not-implemented.md): the
  pairing is planned but not built.
- [`settings/invalid-via`](../settings/invalid-via.md): the `--via` value is
  not a protocol at all.
