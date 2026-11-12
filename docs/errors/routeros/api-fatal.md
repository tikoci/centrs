# `routeros/api-fatal`

RouterOS sent a `!fatal` reply and closed the native-API session. Every
command still waiting on that session fails with this code. A command that
was already sent may or may not have run.

## Context

- `reason`: RouterOS's reason, when it gave one.
- `attributes`: any `=name=value` words on the reply.

RouterOS 7.25.1 sends the reason as a bare word after `!fatal`, not as a
`=message=` attribute: `/quit` gives `!fatal` `session terminated on request`
*(CHR 7.25.1)*.

## Typical triggers

- The session was told to quit: a `/quit` sent through `centrs api`
  *(CHR 7.25.1)*.
- The router ended the session for its own reasons: a logout requested from
  the router, a reboot or shutdown, or the `api` service being disabled
  *(unverified)*.

## Fix

- Check the router's state before you repeat a write: it may have applied.
- Reconnect and run the command again.
- If it repeats, read the router's log (`/log print`) around that time, and
  check `/ip service print` for the `api` or `api-ssl` service.

## Related

- [`transport/connection-closed`](../transport/connection-closed.md): the TCP
  connection closed with no `!fatal`.
- [`routeros/api-trap`](api-trap.md): one command refused; the session lives.
