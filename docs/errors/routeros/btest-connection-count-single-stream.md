# `routeros/btest-connection-count-single-stream`

A **warning** (not a failure): `centrs btest client --protocol tcp
--connection-count <n>` opened **fewer** TCP data connections than `n`. centrs
does implement the multi-connection fan-out — it opens the extra connections that
join the test with the server-negotiated session token — but it falls back to a
single stream when the server negotiates **no** token. The common case is an
**authenticated (EC-SRP5)** session: centrs does not yet capture the post-auth
session token, so authenticated tests stay single-stream. A secondary connection
that fails mid-handshake also reduces the realized count.

The warning reports both the requested and the actually-active connection count.

## Workaround

- For full multi-stream throughput, run the test **unauthenticated**
  (`/tool/bandwidth-server` with `authenticate=no`), where centrs negotiates the
  token and opens all `n` connections.
- Or run several `centrs btest client` processes in parallel and sum their
  throughput.

See `docs/CONSTITUTION.md` for the centrs error/warning contract.
