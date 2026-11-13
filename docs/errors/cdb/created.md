# `cdb/created`

A warning: there was no CDB at the default path, so centrs created an empty
one there and read it as a CDB with no saved devices.

Only the default path, `~/.config/tikoci/winbox.cdb`, is created this way. A
missing file named by `--cdb-file` or `CENTRS_CDB_FILE` is an error instead,
[`cdb/not-found`](not-found.md), so a typo never starts a new CDB.

## Fix

Nothing, on a first run. To add devices, see
[`tip/no-devices`](../../tips/no-devices.md). If you already have a CDB
elsewhere, point centrs at it with `--cdb-file` or `CENTRS_CDB_FILE`.
