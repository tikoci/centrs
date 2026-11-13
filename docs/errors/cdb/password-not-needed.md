# `cdb/password-not-needed`

A warning: a CDB password was given, but the CDB is not encrypted, so the
password was ignored. `ok` and `error` say how the command itself went.

## Typical triggers

- `CENTRS_CDB_PASSWORD` left set in the shell or in a `.env` file centrs
  loads, after switching to an unencrypted CDB *(code)*.
- `--cdb-password` passed out of habit *(code)*.

## Fix

- Drop `--cdb-password`, or unset `CENTRS_CDB_PASSWORD`.
- To encrypt this CDB instead, run `centrs devices encrypt`.

## Related

- [`cdb/decrypt-failed`](decrypt-failed.md)
