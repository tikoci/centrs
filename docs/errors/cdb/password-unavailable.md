# `cdb/password-unavailable`

The CDB needed its key, and the file named for it could not supply one. The
file comes from `--cdb-password-file` or `CENTRS_CDB_PASSWORD_FILE`. It is
missing, unreadable, empty, or not UTF-8 text. `context.path` and
`context.source` name the file and where it was set; the contents are never
shown.

The key is needed only to load an encrypted CDB, for
`devices init --encrypt` and for `devices encrypt`. With an open CDB, or no
CDB, the file is not read: a missing file there is the
[`cdb/password-not-needed`](password-not-needed.md) warning, not this error.

## Typical triggers

- A container secret that is not mounted: `/run/secrets/<name>` is absent
  because the `/app` or Docker definition does not list the secret for this
  service *(code)*.
- The file was rotated or removed after the MCP server started. It is read on
  every CDB load, so the next call sees the change *(code)*.
- The file is not readable by the user centrs runs as *(code)*.
- The file is empty, or was saved with a byte-order mark *(code)*.

## Fix

- Whoever launched centrs set the path: check that the file exists, is
  readable by that process and holds the password as UTF-8. One trailing
  newline is ignored, as for `--password-stdin`.
- On MCP, fix the server's launch configuration and leave the agent out of it:
  the agent cannot supply the key, and should not ask for it.
- To give the key another way, unset the file form and use `--cdb-password`
  or `CENTRS_CDB_PASSWORD`. Setting both forms in one place is
  `usage/conflicting-flags`.

## Related

- [`cdb/password-required`](password-required.md): no key source at all.
- [`cdb/decrypt-failed`](decrypt-failed.md): the file was read, but the key
  is wrong.
