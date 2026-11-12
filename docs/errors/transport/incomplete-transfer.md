# `transport/incomplete-transfer`

`transfer` could not confirm the file it moved: the size on the far side does
not match, or RouterOS shows no size for the file at all.

## Typical triggers

- An upload settled at fewer bytes than were sent, often because the device
  is low on storage.
- A download that arrived short.
- RouterOS lists the file with no size (seen for files under a container's
  root directory, #636). An upload is then unconfirmed, and a download writes
  nothing locally.

## Fix

- Check the file on the device: `centrs transfer <router> list <dir>` or
  `centrs retrieve <router> /file`.
- Re-run the transfer; use `--force` to replace an upload that is wrong.
- Check free space: `centrs retrieve <router> /system/resource`.
- `--verify off` skips the check. Use it only when an unverified copy is
  acceptable.
