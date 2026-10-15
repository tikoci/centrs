# `cmr/selection-includes-controller`

A warning on `execute` or `api` to a CMR controller: a fleet command such as
`/cmr/device/reboot` or `/cmr/device/run-script` selects the controller's own
`/cmr/device` row (`controller=true`) as well as its clients. The command acts
on the controller too.

## Typical trigger

- `labels=all`: per the manual, `all` selects every device, the CMR server
  included.
- An exclusion-only expression such as `labels=-core`, which starts from every
  device.
- A label the controller also carries, such as its architecture (`x86`) or
  RouterOS version, from `auto-labels`.

centrs reads the controller's inventory and evaluates the manual's label
rules over each row's `labels` and `auto-labels`. On a 7.26beta1 lab this
matched the device's own selection for every expression tried. The result is
the controller's current view: a disconnected device's `auto-labels` can be
stale. `context` names the controller and the number of devices selected.

## Fix

Nothing failed; this is information. To leave the controller out, exclude it
explicitly, for example `labels=all,-<controller identity>` (its identity is
an automatic label while `/cmr auto-labels` includes identity).
