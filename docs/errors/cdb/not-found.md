# `cdb/not-found`

The CDB file centrs was told to use does not exist, or, at the default path,
could not be created. Nothing was read or written, and no router was
contacted.

## Typical triggers

- A `--cdb-file` or `CENTRS_CDB_FILE` path that does not exist *(code;
  reproduced with a scratch path)*. centrs never creates a CDB at an explicit
  path, so a typo cannot start an empty one.
- The default path (`~/.config/tikoci/winbox.cdb`) is missing and its
  directory is not writable *(code)*. A missing default CDB is otherwise the
  first-run case: centrs creates an empty one and warns
  [`cdb/created`](created.md).

## Fix

- Check the path in `context.cdbFile`.
- To start a new CDB at that path: `centrs devices init --cdb-file <path>`
  (add `--encrypt --cdb-password …` for an encrypted one).
- For the default path, fix the permissions on `~/.config/tikoci`, or pass
  `--cdb-file` to a writable location.

## Related

- [`cdb/not-found-target`](not-found-target.md): the file exists; the device
  does not.
- [`cdb/parse-failed`](parse-failed.md)
