# `transport/checksum-unavailable`

A warning: `--verify checksum` was asked for, but RouterOS gives no file
digest that `transfer` can read, so it runs the default `--verify size` check
instead. `ok` and `error` say whether the transfer and its check passed.

## What was checked

- REST and native API: the file's size on the router is compared with the
  bytes sent or received *(code)*.
- SFTP: the router reports no size, so nothing is compared. centrs relies on
  SFTP failing a transfer that does not complete *(code)*.

Neither checks the contents.

## Fix

- Use the default, `--verify size`, and the warning goes away.
- To check contents, hash the file and compare the hash with one you trust:
  the publisher's checksum, or the hash of the original file you uploaded.
  Without such a reference, a hash alone proves nothing.

The [`transfer` README](../../../commands/transfer/README.md) explains what
each method can verify.
