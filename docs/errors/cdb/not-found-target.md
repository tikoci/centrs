# `cdb/not-found-target`

No device in the CDB matches the `<router>` name. Nothing was changed, and no
router was contacted.

## Emitted by

- `devices show`, `set` and `remove` *(code)*.
- `retrieve`, `execute`, `api`, `transfer` and `terminal`, only when the CDB
  is explicit (`--cdb-file`, `CENTRS_CDB_FILE` or a CDB password), the CDB
  has no `__default__` record, and `<router>` looks like a name rather than
  an address *(code)*. A name cannot be told apart from a typo, so centrs
  fails closed.

Elsewhere a miss is not an error: an address (IPv4, IPv6, URL or MAC) is
dialed as a literal host, and with the implicit default CDB any unmatched
`<router>` is dialed as given. A `__default__` record turns off this typo
check, even in an explicit CDB: an unmatched name is dialed as a literal
host with the `__default__` credentials *(code)*.

## Context

- `target`: the `<router>` string that matched nothing.

## Typical triggers

- A misspelled name, or a name saved under a different spelling *(code)*.
- A name that is the router's identity, when the device was saved by address
  without an `identity=` property *(code)*.

## Fix

- `centrs devices list` shows every device. `<router>` matches a device's
  target, or its `identity=`, `mac=` or `ip=` property.
- To use the name as a host anyway, pass it as `--host <name>`.
- To save the device: `centrs devices add <address> identity=<name> …`.

## Related

- [`identity/ambiguous`](../identity/ambiguous.md): more than one device
  matched.
- [`cdb/target-not-registered`](target-not-registered.md): the MCP form.
- [`cdb/not-found`](not-found.md): the CDB file itself is missing.
