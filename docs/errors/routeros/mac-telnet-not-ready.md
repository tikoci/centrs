# `routeros/mac-telnet-not-ready`

Code used a MAC-Telnet session before it was open, or after it closed.
Nothing was sent to the device.

## Typical triggers

- A TypeScript caller of the MAC-Telnet session or console sent input or a
  command before `onReady` fired or `open()` resolved *(code)*.
- A command was sent on a console that had already closed, for example after
  the device dropped the session *(code)*.

The `execute` and `terminal` commands wait for the session before they send
anything, so from the CLI this code points at a session that closed under
the command.

## Fix

- Library callers: await `open()`, or wait for `onReady`, before sending, and
  open a new session after a close.
- CLI: run the command again. If the session keeps closing, see the error that
  closed it first, such as
  [`transport/connection-closed`](../transport/connection-closed.md).

## If this looks wrong

From the CLI, this code is a centrs bug. Open an issue with the command, the
`--json` envelope and `centrs --version`. Remove passwords (`--password`,
`--cdb-password`) and other secrets from both first.

## Related

- [`routeros/mac-telnet-error`](mac-telnet-error.md)
- [`routeros/mac-telnet-protocol`](mac-telnet-protocol.md)
