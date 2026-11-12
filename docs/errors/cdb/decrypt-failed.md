# `cdb/decrypt-failed`

The encrypted CDB could not be decrypted, almost always because the password
is wrong. Nothing was read or written, and no router was contacted.

## Context

- `cdbFile`: the CDB that failed.

## Typical triggers

- A wrong `--cdb-password` or `CENTRS_CDB_PASSWORD`: the decrypted bytes do
  not start with the open-CDB magic *(code; reproduced with a scratch CDB)*.
- A file that is not a WinBox-encrypted CDB *(code)*.

A missing password is a different code:
[`cdb/password-required`](password-required.md).

## Fix

- Use the password the CDB was saved with: the WinBox address-book password,
  or the one given to `centrs devices init --encrypt` or `devices encrypt`.
- Check that `CENTRS_CDB_PASSWORD` is not set to an old value, in the shell
  or in a `.env` file centrs loads.
- There is no way to recover a forgotten password. `devices encrypt` keeps a
  plaintext snapshot unless `--no-backup` was passed.

## Related

- [`cdb/password-required`](password-required.md)
- [`cdb/parse-failed`](parse-failed.md)
