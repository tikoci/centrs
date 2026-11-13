# `transport/checksum-unavailable`

A warning: `--verify checksum` was asked for, but RouterOS gives no file
digest that `transfer` can read, so it compares sizes instead. `ok` and
`error` say whether the transfer and its check passed.

## Fix

- Use the default, `--verify size`, and the warning goes away.
- To compare contents, download the file and hash it locally.

The [`transfer` README](../../../commands/transfer/README.md) explains what
each method can verify.
