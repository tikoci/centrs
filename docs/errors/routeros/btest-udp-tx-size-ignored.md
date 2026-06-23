# `routeros/btest-udp-tx-size-ignored`

A non-fatal warning. For UDP `--direction both`, the btest wire protocol carries
a **single** `tx-size` field, so the client and the server transmit with the
same packet size. centrs maps `--local-udp-tx-size` to that field and discards
`--remote-udp-tx-size`. This warning fires only when both flags are set to
different values, so you know which size the session actually used.

## Fix

Drop `--remote-udp-tx-size` for `--direction both`, or set both flags to the
same value. To size each direction independently, run two sessions:
`--direction transmit` (uses `--local-udp-tx-size`) and `--direction receive`
(uses `--remote-udp-tx-size`). See `commands/btest/README.md` and
[`docs/CONSTITUTION.md`](../../CONSTITUTION.md).
