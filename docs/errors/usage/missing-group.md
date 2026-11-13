# `usage/missing-group`

A group fan-out was asked for with an empty group name. Nothing was sent.

## Emitted by

Library callers of `retrieveGroup` with an empty `group` *(code)*. On the CLI,
`--group` always takes a value.

## Fix

- To read a group, call `retrieveGroup` with a non-empty `group`, such as
  `group: "prod"`. `centrs devices groups` lists the names.
- To read one device, call `retrieve` instead, with `targetInput`:
  `retrieve({ targetInput: "router1", path: "/system/resource" })`.
  `retrieveGroup` always needs a group, even when `targetInput` is set.

## Related

- [`cdb/empty-group`](../cdb/empty-group.md): the group exists but has no
  devices.
