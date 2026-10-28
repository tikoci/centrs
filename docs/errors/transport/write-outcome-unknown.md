# `transport/write-outcome-unknown`

A warning on a failed write. The request had already been sent when the
transport failed (a dropped connection, a REST 5xx, a timeout), so the router
may have run it. The error beside this warning says how the call ended, not
whether the write happened.

## Typical trigger

- A connection closed or reset after an `execute` or `api` write was sent.
- A REST 5xx or a timeout on a write.
- A multi-statement `execute` or `api /execute` script refused with
  `routeros/permission-denied`: statements before the refused one may already
  have run (#549). A single refused statement did not run and warns nothing.

centrs never retries a write that it has sent, in single-target or fan-out
mode, because replaying an `add`, a script run or a counter change would apply
it twice (#448). In fan-out, a write is retried only when a retryable
transport failure (`transport/network` or `transport/connection-closed`) ends
it *before* it was sent, for example during remote validation or a native API
login. Any other failure, sent or not, is not retried.

## Fix

Check the router's state before running the write again. For example, read
back the menu you changed with `centrs retrieve`. Re-run only what did not
apply.
