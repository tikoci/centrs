# `settings/unsafe-protocol-blocked`

A cleartext transfer method was asked for without the explicit opt-in.
centrs stopped before connecting: nothing was sent.

## Emitted by

`transfer --via ftp`. FTP sends the password and the file in clear text, so
it sits behind `ALLOW_UNSAFE_PROTOCOLS=ftp` *(code)*.

ftp transfer is not built yet. With the opt-in set, the same command fails as
[`usage/not-implemented`](../usage/not-implemented.md) instead
*(code; reproduced on the CLI)*.

## Context

- `via`: the method that was refused.

## Fix

Use an encrypted or local method: `--via sftp` for large files, or
`--via rest` or `--via native` for small ones. Without `--via`, `transfer`
picks a method by size and direction.

## Related

- [`usage/not-implemented`](../usage/not-implemented.md)
- [`transport/insecure-trust`](../transport/insecure-trust.md)
