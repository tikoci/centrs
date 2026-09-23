# `cdb/create-failed`

A new CDB file could not be created at the resolved location.

`centrs devices init` creates an empty CDB at the path from `--cdb-file`,
`CENTRS_CDB_FILE`, or the default `~/.config/tikoci/winbox.cdb`, making any
missing parent directories. This error means the filesystem refused: typically
a directory on the path is not writable by the current user, or a path
component is a file rather than a directory. The underlying filesystem error
(for example `EACCES`) is preserved as the error's `cause`; run
with `--json` to see it.

Nothing is written when this fails.

## Fix

- Check the permissions of the directories on the path shown in the error.
- Or choose a writable location:
  `centrs devices init --cdb-file PATH`, then pass the same `--cdb-file PATH`
  (or set `CENTRS_CDB_FILE`) on later commands.
