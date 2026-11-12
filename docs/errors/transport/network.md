# `transport/network`

A network operation failed without a more specific cause: not a refusal,
timeout, DNS failure or certificate problem, which have their own codes. The
OS-level error is kept in the error's cause data (`--format json`).

## Typical triggers

- REST or native API: the request failed below HTTP or the API protocol, for
  example a reset connection or a host the OS reports as down.
- Native API: writing to an open connection, or opening a `listen`, failed.
- SSH and SFTP: `ssh`/`sftp` exited with an error that names no connect or
  login cause (`context` carries the exit code).
- `btest server`: the listen address and port could not be bound, often
  because the port is already in use.

## Fix

- Re-run with `--format json` and read the cause: it carries the OS error
  (`ECONNRESET`, `EHOSTDOWN`, `FailedToOpenSocket`, …).
- Confirm the host is reachable from this machine and the service port is
  open (`/ip service print`).
- A router that is rebooting gives this error for a while.
  `centrs retrieve <router> /system/resource --wait 2m` waits until it
  answers.
- For `btest server`, pick a free port with `--port` or another `--bind`
  address.
