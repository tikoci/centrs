# `transport/unsupported-operation`

The transfer method cannot do this operation. Nothing was sent.

## Emitted by

`transfer` *(code)*.

## Context

- `via`, `op`: the method and the operation, for `copy`.
- `remote`, `bytes`, `capBytes`, `viaSource`: the upload, for the size cap.
  `viaSource` names the setting that chose the method.

## Typical triggers

- `transfer copy` over SFTP. RouterOS SFTP has no on-device copy *(code)*.
- An upload larger than 60 KB with `--via rest` or `--via native` pinned.
  RouterOS writes a file over REST or the native API with one
  `/file/set contents=`, and that is capped at 60 KB *(code; CHR, in the
  [`transfer` README](../../../commands/transfer/README.md))*.

## Fix

- `copy`: use `--via rest` or `--via native`.
- A large upload: use `--via sftp`, or leave `--via` out and `transfer`
  picks SFTP for it. If `viaSource` names a setting such as
  `CENTRS_TRANSFER_VIA`, an explicit `--via sftp` overrides it.

## Related

- [`transport/auto-method`](auto-method.md)
