# `mndp/encode-failed`

An MNDP packet could not be built because a MAC or IPv4 field is malformed.
Nothing was sent.

## Emitted by

Library callers of `encodeMndpPacket` *(code)*. The `discover` command only
decodes MNDP, so it never raises this code.

## Context

- `mac` or `ipv4`: the rejected value.

## Fix

Pass a MAC as six colon-separated octets (`e4:8d:8c:11:22:33`) and an IPv4
address as a dotted quad (`192.0.2.5`).

## Related

- [`mndp/malformed`](malformed.md)
