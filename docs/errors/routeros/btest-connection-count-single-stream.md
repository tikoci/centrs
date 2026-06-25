# `routeros/btest-connection-count-single-stream`

A **warning** (not a failure): `centrs btest client --protocol tcp
--connection-count <n>` with `n > 1` sends the count to the bandwidth server in
the command packet, but centrs still drives a **single** TCP data connection. The
parallel-stream fan-out (opening the extra connections that join the test with the
negotiated session token) is not yet implemented, so reported throughput will not
scale with the count.

## Workaround

Until fan-out lands:

- Drop `--connection-count` (or set it to `1`) to avoid the misleading
  expectation — a single stream is what actually runs.
- To approximate parallel streams, run **several `centrs btest client`
  processes in parallel** against the same server and sum their throughput.

See `docs/CONSTITUTION.md` for the centrs error/warning contract.
