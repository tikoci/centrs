# `routeros/api-protocol`

A reply on the native-API connection was not valid API framing, so centrs
stopped reading it. Every command waiting on that connection fails. A command
that was already sent may or may not have run.

## Typical triggers

- A byte that cannot start a word length (`0xF8` or higher) where a word
  should begin *(code)*. That is a corrupt stream, or a peer that is not the
  RouterOS API.

Pointing `--via native-api` at the wrong service usually fails differently.
On CHR 7.25.1, the HTTP (`www`), `api-ssl` and SSH ports each closed the
connection, which centrs reports as
[`transport/connection-closed`](../transport/connection-closed.md).

## Fix

- Check the port: the `api` service is TCP 8728 and `api-ssl` (TLS) is 8729
  by default (`/ip service print`). A CDB `api-port=` or `--port` can point it
  elsewhere.
- Remove anything on the path that rewrites TCP payloads, such as a proxy.

## If this looks wrong

If the port is the router's `api` service and the error repeats, it is a
centrs decoder bug. Open an issue with the command, the `--json` envelope,
the RouterOS version and `centrs --version`.

## Related

- [`transport/connection-closed`](../transport/connection-closed.md)
- [`internal/native-api-length`](../internal/native-api-length.md): centrs
  tried to send a word too long to encode.
