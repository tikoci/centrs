# `wait/deadline-exceeded`

The wait deadline passed before readiness or its condition was established.

## Fix

Check the predicate and the router's current state, then choose a longer
`--wait` if the operation legitimately needs more time. `--timeout` bounds
individual requests and does not extend the overall deadline.

`meta.operation.wait` reports `deadline-elapsed`, elapsed milliseconds,
attempts and completed observations. A failed or unfinished read never proves
an empty result. If the last attempt failed with a transient transport error,
that error is preserved instead of this code.
