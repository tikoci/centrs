# `tip/credentials-missing`

The saved device has no stored password, and there is no `__default__`
record to fall back on. `devices show` gives this tip. A command that dials
this device will log in with an empty password unless you give one, which
RouterOS refuses for any user that has a password.

## Give it a password

Choose one, from the narrowest to the broadest:

- **For one call:** `--password` (or `--password-stdin` on `devices add` and
  `set` only), or `CENTRS_PASSWORD` in the environment. Nothing is saved.
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
  password. Save the key path with `devices set <router> ssh-key=<path>`.
- **MAC-Telnet** needs a user and a password like the IP transports. A user
  whose only login is RADIUS fails as
  [`transport/auth-failed`](../errors/transport/auth-failed.md).

## Related

- [`tip/no-devices`](no-devices.md)
- [`transport/auth-failed`](../errors/transport/auth-failed.md)
