# `cdb/target-not-registered`

The target is not a registered device in the CDB, and the surface that was
asked only acts on registered devices. Nothing was sent.

## Emitted by

The MCP server's RouterOS-facing tools *(code)*. On MCP the CDB is the
allowlist: a target must be a saved device, selected by its target or its
`identity=`, `mac=` or `ip=` property. The CLI dials an unregistered address
as a literal host instead.

## Context

- `target`: the target that is not registered, or
- `group`: a group with no members, or
- `quickchr`: quickchr machine names, which MCP does not accept.

## Typical triggers

- A tool call named an address or name that is not in the CDB *(code)*.
- A `group` that has no devices *(code)*.
- A quickchr target sent through MCP *(code)*.

## Fix

- Register the device first: the `centrs_devices` tool with `op: "add"`, or
  `centrs devices add <address> …` from a shell. Then call the tool again.
- For a group, add devices with `--group <name>`, or pick a group that has
  members (`centrs devices groups --members`).

## Related

- [`cdb/not-found-target`](not-found-target.md): the CLI's name miss.
- [`identity/ambiguous`](../identity/ambiguous.md)
