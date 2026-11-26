# `cdb/password-not-needed`

A warning: a CDB password was given, but the CDB is not encrypted, so the
password was ignored. `ok` and `error` say how the command itself went.

## Typical triggers

- `CENTRS_CDB_PASSWORD` left set in the shell after switching to an
  unencrypted CDB *(code)*.
- `--cdb-password` passed out of habit *(code)*.
- `CENTRS_CDB_PASSWORD_FILE` set image-wide in a container whose CDB is open
  or not created yet. The file is not read, and the message says whether it
  exists, so a missing secret mount shows up without failing the run *(code)*.

## Fix

- Drop `--cdb-password`, or unset `CENTRS_CDB_PASSWORD`. A file form
  (`--cdb-password-file`, `CENTRS_CDB_PASSWORD_FILE`) can stay set where an
  encrypted CDB is expected later; it never converts an open CDB.
- To encrypt this CDB instead, run `centrs devices encrypt` with the new
  password in `--cdb-password` or `CENTRS_CDB_PASSWORD`, or in the file
  `--cdb-password-file` or `CENTRS_CDB_PASSWORD_FILE` names. An empty value
  fails with [`cdb/password-required`](password-required.md); an empty file
  (or one holding only a newline) fails with
  [`cdb/password-unavailable`](password-unavailable.md).

## Related

- [`cdb/decrypt-failed`](decrypt-failed.md)
