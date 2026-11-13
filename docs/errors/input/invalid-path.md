# `input/invalid-path`

A path centrs cannot send as given: an `api` endpoint whose row id does not
fit the method, an endpoint with no menu path, or a file path SFTP cannot
quote. Nothing was sent.

## Emitted by

- `api` *(code)*.
- `transfer --via sftp` *(code)*.

## Context

- `method`, `path`, `id`: the `api` request, when `api` raised it.
- `path`: the file path, when SFTP raised it.

## Typical triggers

- `api -X PATCH` or `-X DELETE` on a menu with no row id:
  `ip/address` instead of `ip/address/*1` *(code)*. These change one row, so
  they need its id.
- `api -X PUT` or `-X POST` with a row id: `ip/address/*1`. These do not
  address a row; pass `.id` as a field, `-f .id=*1`, when the command takes
  one *(code)*.
- An endpoint with no menu segment, such as `/` *(code)*.
- A file name with a double quote or a newline over SFTP *(code)*. RouterOS
  file names do not use them.

## Fix

Follow `remediation`. Find row ids with a GET of the menu:
`centrs api <router> ip/address`.

## Related

- [`validation/unknown-path`](../validation/unknown-path.md)
