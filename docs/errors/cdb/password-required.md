# `cdb/password-required`

A CDB password is required for decryption or explicit encryption.

## Fix

Pass `--cdb-password` or set `CENTRS_CDB_PASSWORD` to the CDB password.
`devices init --encrypt` and `devices encrypt` require a non-empty password,
even when the file is currently open. A password alone never implicitly
converts an existing open CDB; use `devices encrypt` explicitly.
