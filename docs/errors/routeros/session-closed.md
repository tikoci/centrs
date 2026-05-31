# `routeros/session-closed`

RouterOS closed the session before the request completed. Over REST this maps to
the 60-second hard timeout RouterOS enforces on a single HTTP request.

## Typical RouterOS strings

- `Session closed`

## Fix

RouterOS enforces a 60-second hard timeout on REST sessions; reduce the scope of
the request or choose a path that completes within that ceiling.
