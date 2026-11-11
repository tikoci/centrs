# `transport/auth-failed`

RouterOS rejected the credentials over the transport.

## When it happens

The connection opened, and the router refused the login: a wrong username or
password on REST (HTTP 401), native API, SSH or MAC-Telnet. Over MAC-Telnet it
also covers a login the device cannot attempt for this user:

- **MTWEI and RADIUS.** When the device has `/user aaa use-radius=yes` and the
  username has no local login (or no username was resolved), RouterOS answers
  the login with its public key and no salt (a 33-byte PASSSALT). It has no
  local password to check an MTWEI proof against, so a RADIUS-only user cannot
  log in over MAC-Telnet. The error's `context.saltLength` is `33`.
- **MD5 refused.** Current RouterOS offers the classic MD5 salt when MTWEI is
  not offered, then refuses the proof even for valid credentials. Leave MTWEI
  enabled (the default).

## Fix

- Check the username and password that resolved for this target
  (`centrs devices show <target>`, `CENTRS_USER` / `CENTRS_PASSWORD`, or the
  flags). The envelope's `meta.settings` says where each one came from.
- For MAC-Telnet, use a user in the device's local `/user` list, or reach the
  device over another transport that can authenticate the RADIUS user.
