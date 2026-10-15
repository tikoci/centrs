# `cmr/empty-selection`

The `--labels` expression of `execute --cmr` matched no device in the
controller's `/cmr/device` inventory, so nothing ran.

- For a **read**, it is a warning: `ok: true` with an empty selection and exit
  code 0, the same as an empty CDB group. A collector that polls a sometimes
  empty label stays quiet.
- For a **write-shaped** command it is an error (`ok: false`, exit code 1),
  with or without `--yes`, so a misspelled label does not look like a
  successful bulk write. RouterOS refuses an empty selection the same way
  (`no devices selected`). `context.write` is `true`.

The same code is a **warning** on a CMR fleet command run directly with
`execute` or `api`, such as `/cmr/vlan/add labels=EDGE` or
`/cmr/device/reboot labels=Edge`: by the controller's inventory now, its
selection reaches no device. RouterOS refuses an empty selection for a
`/cmr/device` command itself; it accepts a rule whose labels match nothing,
and the rule applies to devices that get the label later.

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
