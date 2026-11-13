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

Opt the device in, then retry the MCP call with `confirm: true`:

```sh
centrs devices set <router> mcp=rw
```

`confirm` alone is not enough: the device's policy decides, and `mcp=rw` is a
deliberate choice to let an agent change that router.

## Limits

centrs does not require that a person makes that choice. The MCP
`centrs_devices` tool can set the property too: `op: "set"` with an `updates`
entry `mcp=rw` and `confirm: true` *(code)*. Both steps are tool calls, so an
agent that may confirm its own calls can opt a device in and then write to it.
If only a person should grant writes, have your MCP client ask you before
every `centrs_devices` call that changes a record.

## Related

- [`usage/confirmation-required`](../usage/confirmation-required.md)
- [`cdb/target-not-registered`](target-not-registered.md)
