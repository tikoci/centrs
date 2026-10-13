# `transport/write-outcome-unknown`

A warning on a failed write. The request had already been sent when the
transport failed (a dropped connection, a REST 5xx, a timeout), so the router
may have run it. The error beside this warning says how the call ended, not
whether the write happened.

## Typical trigger

- A connection closed or reset after an `execute` or `api` write was sent.
- A REST 5xx or a timeout on a write.

centrs never retries a write that it has sent, in single-target or fan-out
mode, because replaying an `add`, a script run or a counter change would apply
it twice (#448). A write that failed *before* it was sent, for example while
it was being validated, is retried in fan-out like a read.

## Fix

Check the router's state before running the write again. For example, read
back the menu you changed with `centrs retrieve`. Re-run only what did not
apply.
