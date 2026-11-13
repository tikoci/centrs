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

`mcp=ro` is a block in centrs, not the security boundary. What an agent can
change is decided by the RouterOS account the CDB holds for the device, and by
RouterOS's policy for that account. To be sure an agent cannot write, give the
device an account without write rights. The
[`mcp` README](../../../commands/mcp/README.md) notes one case where RouterOS
policy alone did not stop a write.

centrs also does not require that a person sets `mcp=rw`. The MCP
`centrs_devices` tool can set it too: `op: "set"` with an `updates` entry
`mcp=rw` and `confirm: true` *(code)*. An agent that may confirm its own calls
can therefore opt a device in and then write to it. To keep that choice with a
person, have your MCP client ask you before every `centrs_devices` call that
changes a record.

## Related

- [`usage/confirmation-required`](../usage/confirmation-required.md)
- [`cdb/target-not-registered`](target-not-registered.md)
