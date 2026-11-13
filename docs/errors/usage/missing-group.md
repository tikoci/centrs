# `usage/missing-group`

A group fan-out was asked for with an empty group name. Nothing was sent.

## Emitted by

Library callers of `retrieveGroup` with an empty `group` *(code)*. On the CLI,
`--group` always takes a value.

## Fix

Pass the name of a device group, such as `group: "prod"`.
`centrs devices groups` lists them. To read one device, pass `target`
instead of `group`.

## Related

- [`cdb/empty-group`](../cdb/empty-group.md): the group exists but has no
  devices.
