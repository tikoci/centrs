# `transport/connection-closed`

The connection closed before centrs had a result: the device or the network
dropped it, or the session had already been closed.

## Typical triggers

- Native API: the router closed the connection mid-session or before login
  finished (an `api` service `address=` restriction, a reboot, or a dropped
  link).
- REST: RouterOS answered with an HTTP 5xx and dropped the request. Under
  fan-out load RouterOS can drop a share of parallel requests; fan-out retries
  this code.
- MAC-Telnet: the console session ended, or ended before login.
- Library use: a command was sent on a session the caller had closed.

## Fix

- Retry. If a write was in flight, check the router's state first: the result
  may carry [`transport/write-outcome-unknown`](write-outcome-unknown.md).
- For fan-out, lower `--concurrency`.
- Check the service's `address=` list and that the router is not rebooting
  (`/ip service print`, `/log print`).
