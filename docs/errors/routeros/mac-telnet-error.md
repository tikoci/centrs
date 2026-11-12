# `routeros/mac-telnet-error`

The device sent a MAC-Telnet error packet, and centrs ended the session. The
packet's text is in `summary`. If the session was already running a command,
that command may or may not have run.

## Emitted by

`execute --via mac-telnet` and `terminal`.

## Typical triggers

- The device sends an error packet (control type 7) *(code)*. Which
  conditions make RouterOS send one has not been reproduced on a device
  *(unverified)*.

Failed logins are not this code. A wrong user or password, and a RADIUS-only
user with no local login, fail as
[`transport/auth-failed`](../transport/auth-failed.md) *(CHR 7.25.1)*.

## Fix

- Read the device's text in `summary`.
- Check that MAC-Telnet is allowed on the interface you reach the device on:
  `/tool/mac-server print` shows its `allowed-interface-list` (`all` on a
  fresh CHR 7.25.1).
- Try again, or use an IP transport (`--via ssh`, `--via native-api`).

## If this looks wrong

Open an issue with the command, the `--json` envelope (its `summary` holds
the device's text), the RouterOS version and `centrs --version`. A device
string that recurs should get its own code.

## Related

- [`transport/auth-failed`](../transport/auth-failed.md)
- [`routeros/mac-telnet-protocol`](mac-telnet-protocol.md): a packet centrs
  could not decode.
- [`routeros/mac-telnet-unsupported-auth`](mac-telnet-unsupported-auth.md)
