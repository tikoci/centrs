# `tip/no-devices`

The CDB centrs read has no saved devices yet. Nothing is wrong: a new CDB
starts empty. `devices list` and a command run without `<router>` give this
tip.

## Where the CDB is

By default it is `~/.config/tikoci/winbox.cdb` under your home directory
(`%USERPROFILE%\.config\tikoci\winbox.cdb` on Windows), the same file format as
the WinBox address book. `--cdb-file` or `CENTRS_CDB_FILE` points centrs at
another file. If you expected devices here, check `meta.operation.cdbFile`
in the `devices list --json` envelope: an empty result usually means centrs
read a different file from the one you filled.

## Add devices

- **From the LAN:** `centrs discover --save` listens for MikroTik neighbors
  (MNDP, UDP port 5678) for 15 seconds and saves each one it hears. Only
  routers on the same layer-2 segment answer, and discovery saves no
  credentials. In an agent sandbox the listener may be refused; see
  [`mndp/listen-failed`](../errors/mndp/listen-failed.md).
- **By hand:** `centrs devices add <address> --user <name> --password-stdin`,
  with the password on stdin so it stays out of your shell history.
- **Shared credentials:** if many routers use the same login,
  `centrs devices add __default__ --user <name> --password-stdin` stores it
  once, and every saved device without its own login uses it.

## No CDB needed

A command does not need a saved device. `<router>` can be an address,
with the login from `--user` and `--password` or from `CENTRS_USERNAME` and
`CENTRS_PASSWORD`. Over MCP, by contrast, every target must be a saved device
([`cdb/target-not-registered`](../errors/cdb/target-not-registered.md)).

## Related

- [`tip/credentials-missing`](credentials-missing.md): a saved device has no
  password.
- [`cdb/not-found`](../errors/cdb/not-found.md): there is no CDB file at all.

<!-- cspell:ignore USERPROFILE -->
