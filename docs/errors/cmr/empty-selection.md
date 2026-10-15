# `cmr/empty-selection`

The `--labels` expression matched no device in the controller's
`/cmr/device` inventory, so nothing ran.

- For a **read**, it is a warning: `ok: true` with an empty selection and exit
  code 0, the same as an empty CDB group. A collector that polls a sometimes
  empty label stays quiet.
- For a **write-shaped** command it is an error (`ok: false`, exit code 1),
  with or without `--yes`, so a misspelled label does not look like a
  successful bulk write. RouterOS refuses an empty selection the same way
  (`no devices selected`). `context.write` is `true`.

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
