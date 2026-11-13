# `cdb/write-not-permitted`

An MCP write was refused because the device is not opted into MCP writes. Its
`mcp` device property is `ro`, which is the default. Nothing was sent to the
router.

## Emitted by

The MCP `centrs_execute` tool, for a command that writes *(code)*. The CLI
does not read `mcp`.

## Context

- `target`: the device.
- `writePolicy`: its current policy (`ro`).

## Fix

A person, not the agent, opts the device in from the CLI:

```sh
centrs devices set <router> mcp=rw
```

Then retry the MCP call with `confirm: true`. `confirm` alone is not enough:
the device's policy decides, and `mcp=rw` is a deliberate choice to let an
agent change that router.

## Related

- [`usage/confirmation-required`](../usage/confirmation-required.md)
- [`cdb/target-not-registered`](target-not-registered.md)
