# `routeros/btest-connection-count-single-stream`

--connection-count is sent to the server, but centrs still drives a single TCP data stream; multi-stream fan-out is not yet implemented, so throughput will not scale with the count.

## Fix

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) for the centrs error
contract. This stub will be expanded with the typical trigger and remediation
for `routeros/btest-connection-count-single-stream`.
