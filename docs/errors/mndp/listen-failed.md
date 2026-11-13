# `mndp/listen-failed`

centrs could not open the UDP socket it listens on for MNDP neighbor
announcements. Nothing was sent or received. This is a fault on the machine
running centrs, not on any router.

## Emitted by

`discover`.

## Context

- `port` and `host`: the address centrs tried to bind (UDP 5678 on
  `0.0.0.0` by default).
- `cause`: the operating system's error code, such as `EADDRINUSE` or
  `EPERM`.

## Typical triggers

- An agent sandbox (a coding agent's shell) that does not allow UDP
  sockets. It fails at once with `EPERM` *(field)*. The same sandbox usually
  refuses TCP too, so every router looks down
  ([`transport/connection-refused`](../transport/connection-refused.md)).
- Another program holds UDP 5678 and does not share it, often WinBox
  *(code)*. centrs sets `SO_REUSEPORT`, so this needs a program that does
  not.
- `--port` names a port the user may not bind *(code)*.

## Fix

- In a sandbox, run `discover` outside it, or allow UDP and LAN access for
  the agent's shell.
- Close the program holding UDP 5678, or pass another `--port` (routers
  announce on 5678, so only a relay or test sends elsewhere).
- Check the port: `lsof -nP -iUDP:5678` on macOS, `ss -u -l -n -p` on Linux.

## Related

- [`discover/failed`](../discover/failed.md)
- [`discover/broadcast-unavailable`](../discover/broadcast-unavailable.md)
