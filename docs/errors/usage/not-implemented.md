# `usage/not-implemented`

centrs recognizes this command form, but it is not built yet. Nothing was
sent or changed.

## Emitted by

- `devices edit`, and the MCP `centrs_devices` tool with `op: edit`. `edit`
  is reserved for an interactive editor *(code)*.
- `transfer --via scp`, `--via fetch`, and `--via ftp` once
  `ALLOW_UNSAFE_PROTOCOLS=ftp` is set *(code)*.

## Fix

- Instead of `devices edit`, use `centrs devices set <router>` with the flags
  and `key=value` properties to change.
- Instead of `scp`, `fetch` or `ftp`, use `--via sftp` for large files, or
  `--via rest` or `--via native` for files up to 60 KB.

## Related

- [`settings/unsafe-protocol-blocked`](../settings/unsafe-protocol-blocked.md)
- [`routeros/protocol-not-implemented`](../routeros/protocol-not-implemented.md)
