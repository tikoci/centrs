# `routeros/mac-telnet-protocol`

centrs received a MAC-Telnet datagram it could not decode, and closed the
session. If the session was already running a command, that command may or
may not have run.

## Emitted by

`execute --via mac-telnet` and `terminal`.

## Typical triggers

- A datagram shorter than the 22-byte MAC-Telnet header *(code)*.
- A control block whose declared length runs past the end of the datagram
  *(code)*.

Both mean a truncated or corrupt datagram, or something on UDP port 20561
that is not a RouterOS MAC-Telnet server.

## Fix

- Run the command again: MAC-Telnet is UDP, and one bad datagram ends the
  session.
- Check that the target MAC address is the RouterOS device you mean, and that
  nothing else on the segment answers MAC-Telnet.
- If it repeats, use an IP transport (`--via ssh`, `--via native-api`).

## If this looks wrong

If the device is a normal RouterOS router, this is a centrs decoder bug.
Open an issue with the command, the `--json` envelope, the RouterOS version
and `centrs --version`. A packet capture of UDP 20561 helps; strip anything
sensitive from it first.

## Related

- [`routeros/mac-telnet-error`](mac-telnet-error.md)
- [`input/mac-address`](../input/mac-address.md)
