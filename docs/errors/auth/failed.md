# `auth/failed`

The SSH login was rejected. This code comes from the batch SSH clients:
`execute --via ssh` and sftp `transfer`. Logins over REST, the native API and
MAC-Telnet fail as
[`transport/auth-failed`](../transport/auth-failed.md).

## Typical triggers

- No key the device accepts for that user. Batch SSH never sends a password:
  it authenticates with `--ssh-key` (or `CENTRS_SSH_KEY`, or the CDB
  `ssh-key=` key), plus the keys in your OpenSSH configuration or agent.
- The user's group lacks the `ssh` policy. RouterOS then refuses the login
  with `Permission denied (publickey)`.

`context.sshKeySelected` says whether an explicit key was chosen; the cause
data holds OpenSSH's own message.

## Fix

- Install the matching public key for the user on the device:
  `/user/ssh-keys import` (`/user/ssh-keys print` lists the user's keys).
- Confirm the user's group has the `ssh` policy (`/user group print`).
- Password login is separate. On RouterOS 7.21 and later,
  `/ip/ssh password-authentication` (default `yes-if-no-key`) refuses it for
  a user who has a key. Use `--via rest-api` or `--via native-api` to log in
  with a password.
