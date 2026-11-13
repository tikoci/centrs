# `mndp/malformed`

An MNDP datagram could not be decoded. `discover` skips such datagrams and
reports how many as a warning; a library call to `decodeMndpPacket` gets this
error.

## Emitted by

- `discover`, as a warning with `context.count` *(code)*.
- Library callers of `decodeMndpPacket`, as an error *(code)*.

## Context

- `count`: the skipped datagrams, on the `discover` warning.
- The decode error names the offset and record that failed.

## Typical triggers

Something other than a RouterOS neighbor announcement on UDP port 5678: a
truncated datagram, or a different protocol sharing the port *(code)*.

## Fix

Nothing, for a few skipped datagrams: the neighbors that decoded are in the
result. If a RouterOS device you expect is missing and the count is not zero,
open an issue with the RouterOS version and `centrs --version`. A capture of
UDP 5678 helps; MNDP carries device identities and addresses, so share it
only where that is acceptable.

## Related

- [`mndp/listen-failed`](listen-failed.md)
- [`discover/failed`](../discover/failed.md)
