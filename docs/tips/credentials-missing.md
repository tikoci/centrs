# `tip/credentials-missing`

The saved device has no stored password, and there is no `__default__`
record to fall back on. `devices show` gives this tip. A command that dials
this device will log in with an empty password unless you give one, which
RouterOS refuses for any user that has a password.

## Give it a password

Choose one, from the narrowest to the broadest:

- **For one call:** `--password` or `CENTRS_PASSWORD` on the command that
  dials the device. Nothing is saved.
- **On the device record:**
  `centrs devices set <router> --password-stdin`, with the password on stdin.
  `--password <secret>` works too, but the value then sits in your shell
  history.
- **For every device without one:**
  `centrs devices add __default__ --user <name> --password-stdin`. Each field
  falls back separately, so a device with its own user and no password takes
  only the password from `__default__`.

## By transport

- **SFTP transfers** (`transfer --via sftp`) log in with an SSH key, never a
  password (see the [`transfer` README](../../commands/transfer/README.md)).
  Save the key path with `devices set <router> ssh-key=<path>`.
- **MAC-Telnet** needs a user and a password like the IP transports. A user
  whose only login is RADIUS fails as
  [`transport/auth-failed`](../errors/transport/auth-failed.md) (CHR 7.25.1,
  see [`routeros/mac-telnet-error`](../errors/routeros/mac-telnet-error.md)).

## Related

- [`tip/no-devices`](no-devices.md)
- [`transport/auth-failed`](../errors/transport/auth-failed.md)
