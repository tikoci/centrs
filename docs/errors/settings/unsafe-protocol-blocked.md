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

Use another method: `--via sftp` for large files, or `--via rest` or
`--via native` for small ones. Without `--via`, `transfer` picks a method by
size and direction.

Only `sftp` is encrypted by default. With a bare host, `rest` uses plain HTTP
(port 80) and `native` plain TCP (port 8728), so they send the password and
the file in clear text too. They use TLS only with an `https://` target,
`--port 8729` for `native`, or a saved `www-ssl-port` or `api-ssl-port`
device property.

## Related

- [`usage/not-implemented`](../usage/not-implemented.md)
- [`transport/insecure-trust`](../transport/insecure-trust.md)
