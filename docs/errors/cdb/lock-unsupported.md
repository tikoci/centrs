# `cdb/lock-unsupported`

The CDB filesystem does not support the hard links required for write locking.

## Typical trigger

A revision-checked CDB write needs a sibling hard-link lock. The filesystem
reported `ENOTSUP`, `EOPNOTSUPP`, or `ENOSYS` when creating that link, so centrs
refused the write before changing the CDB or creating a backup. The error
context names `lockFile`, and its structured cause preserves the filesystem
error.

`EPERM` and `EACCES` alone do not establish missing hard-link support; those
permission failures retain their original cause instead of receiving this code.

## Fix

Move the CDB to a filesystem that supports hard links, such as NTFS on Windows
or a local filesystem on Linux/macOS. Select the new location with `--cdb-file`
or `CENTRS_CDB_FILE`. For a shared drive, confirm that its server supports hard
links and cross-process locking. Do not bypass the lock or use an unsynchronized
write to work around this error.
