# `cdb/password-required`

A CDB password is required for decryption or explicit encryption.

## Fix

Give the CDB password with `--cdb-password` or `CENTRS_CDB_PASSWORD`, or name
a file holding it with `--cdb-password-file` or `CENTRS_CDB_PASSWORD_FILE`.
`devices init --encrypt` and `devices encrypt` require a non-empty password,
even when the file is currently open. A password alone never implicitly
converts an existing open CDB; use `devices encrypt` explicitly.
