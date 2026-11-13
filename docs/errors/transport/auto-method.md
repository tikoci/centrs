# `transport/auto-method`

A warning: with no `--via`, `transfer` chose SFTP, because the upload is
larger than 60 KB, the most REST and the native API can write. The transfer
ran over SFTP.

## Why it matters

SFTP logs in with an SSH key only, never with the password REST uses. A
device with only a password fails the SFTP login, where a small upload over
REST would have worked.

## Fix

Nothing, if SFTP works. Otherwise give the device a key,
`centrs devices set <router> ssh-key=<path>`, and add the public key to the
RouterOS user. To make the choice explicit, pass `--via sftp`.

## Related

- [`transport/unsupported-operation`](unsupported-operation.md): a large
  upload with REST or native pinned.
