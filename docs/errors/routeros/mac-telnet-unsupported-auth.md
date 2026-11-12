# `routeros/mac-telnet-unsupported-auth`

The device requested an unsupported MAC-Telnet auth mode.

## When it happens

The device's password-salt reply (PASSSALT) has a length centrs does not know.
centrs expects 16 bytes (classic MD5) or 49 bytes (MTWEI: a 33-byte server key
plus a 16-byte salt). A 49-byte reply to a session that did not offer MTWEI
also lands here.

A 33-byte reply to an MTWEI offer is not this error: it means the device has
no local login for the username, and it fails as `transport/auth-failed`.

## Fix

- Leave MTWEI enabled (the default), so the client advertises its public key.
- Note the salt length from the summary, the device model and its RouterOS
  version, and report it: it is a reply centrs has not seen.
