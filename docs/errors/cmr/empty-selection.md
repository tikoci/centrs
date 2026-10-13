# `cmr/empty-selection`

A warning: the `--labels` expression matched no device in the controller's
`/cmr/device` inventory, so nothing ran. The result is an empty selection with
exit code 0, the same as an empty CDB group.

## Typical trigger

- A misspelled label. RouterOS label names are case-sensitive, and an unknown
  label is accepted silently rather than rejected.
- A missing comma: `labels=office+ap` is one label named `office+ap`; use
  `office,+ap`.
- Every matching device was removed from the controller.

## Fix

Check the labels on the controller (`/cmr/device print` shows `labels` and
`auto-labels`) and re-run. `--labels all` selects every device, including the
controller.
