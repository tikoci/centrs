# `cmr/client-disconnected`

CMR skipped the client because it is not connected to the controller. The
command was **not** sent to it.

## Typical trigger

The controller answered `run-script` for this client with status `skipped` and
output `disconnected`. The client is down, unpaired, or cannot reach the
controller on TCP/54321. A client that has just gone down may instead stall
until the controller notices; that case surfaces as
[`cmr/validation-incomplete`](./validation-incomplete.md) or
[`cmr/outcome-unknown`](./outcome-unknown.md).

## Fix

- On the client, `/cmr/client print` should show `status: paired,connected`.
- Check its route and firewall towards the controller (TCP/54321).
- Re-run once it reconnects; the other members' results are unaffected.
