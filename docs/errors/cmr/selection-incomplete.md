# `cmr/selection-incomplete`

centrs asked the controller, for every `/cmr/device` row, whether it matches
`--labels`. At least one row got no answer, so the selection is not known and
**nothing was run**.

## Typical trigger

A per-device preflight call timed out, was cancelled, or lost its connection
before the controller either refused it (`no devices selected`, so not a
member) or returned a row (a member).

## Fix

- Check that the controller is reachable and responsive, then retry.
- Raise `--timeout` if the controller is slow.
- centrs never runs a partial selection, because a smaller set that reports
  success would hide the clients it skipped.
