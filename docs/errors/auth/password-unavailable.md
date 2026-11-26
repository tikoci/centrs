# `auth/password-unavailable`

A RouterOS password file could not supply a password. The file comes from
`--password-file` or `CENTRS_PASSWORD_FILE`. It is missing, unreadable, not
a regular file (a FIFO or a device), empty, or not UTF-8 text. `context.path` and `context.source` name the file
and where it was set; the contents are never shown.

A password file outranks CDB records, as `--password` and `CENTRS_PASSWORD`
do. So when one is named and cannot be read, centrs stops rather than log in
with the record's password. Paths that use no password read no file:
interactive `terminal` over ssh, and `btest server --no-authenticate`.

## Typical triggers

- `CENTRS_PASSWORD_FILE` points at a secret that is not mounted in this
  container *(code)*.
- The file is not readable by the user centrs runs as *(code)*.
- The file is empty, or was saved with a byte-order mark *(code)*.

## Fix

- Check that the file exists, is readable and holds the password as UTF-8.
  One trailing newline is ignored.
- To use the CDB record's password instead, unset `CENTRS_PASSWORD_FILE`.
  Set it per invocation rather than in a container-wide environment: there it
  replaces every record's password.

## Related

- [`cdb/password-unavailable`](../cdb/password-unavailable.md): the same for
  the CDB key.
- [`transport/auth-failed`](../transport/auth-failed.md): the password was
  read, but the router refused it.
