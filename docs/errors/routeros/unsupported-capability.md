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

## Context

- `via`: the protocol asked for.
- `capability`: what the command needed (`retrieve` or `execute`).

## Fix

Pick a transport that has the capability. `retrieve` runs over `rest-api` or
`native-api`; `execute` runs over those two, `ssh` and `mac-telnet`. The
[protocol matrix](../../MATRIX.md) lists every cell. If the `--via` came from
`CENTRS_VIA` or the device's saved `via=` property, override it with an
explicit `--via`.

## Related

- [`routeros/protocol-not-implemented`](protocol-not-implemented.md): the
  pairing is planned but not built.
- [`settings/invalid-via`](../settings/invalid-via.md): the `--via` value is
  not a protocol at all.
