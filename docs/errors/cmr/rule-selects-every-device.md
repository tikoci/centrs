# `cmr/rule-selects-every-device`

A warning on `execute` or `api` to a CMR controller: a `/cmr/vlan`,
`/cmr/wifi`, `/cmr/wifi/radio` or `/cmr/upgrade` rule command has no device
`labels`, so the rule applies to every device the controller manages, the
controller included. For `/cmr/vlan` it fires only when `port-labels` is
missing too.

## Typical trigger

- `/cmr/vlan/add vlan-ids=10` with no `labels` and no `port-labels`. The
  manual warns that such a rule moves every port of every connected device
  into `cmr-bridge`, the controller included, which cuts the whole fleet's
  management access.
- `/cmr/wifi/add ssid=Office` with no `labels`, or labels that are only band
  labels (`+5ghz`). The network takes over the radios of every device.
- `set`, `remove`, `enable` or `disable` of an existing rule that has no
  `labels`. Its reach is every device too.

centrs reads the rule's `labels` from the command (`add`) or from the rule
itself (the other verbs). A rule added without `labels` stores none (7.26beta1
CHR). The command still runs as typed; the warning rides the envelope, and
the write gate's prompt and `usage/confirmation-required` summary repeat it.

## Fix

Give the rule explicit selectors, for example
`/cmr/vlan/add labels=office-ap port-labels=ether1 vlan-ids=10 role=trunk`.
Check which devices a label selects with
`centrs retrieve <controller> /cmr/device` (`labels`, `auto-labels`). Answer
`yes` or pass `--yes` only if every device, the controller included, is
intended.
