# transfer

Copy files to and from a RouterOS device.

Status: `not-started`. This file is a stub. `transfer` appears in the
constitution's protocol-selection table (`ssh`/`scp` preferred; small REST-API
file ops as a fallback) but has no matrix grid row yet.

## Intent

- Default to `scp` over SSH (lands with the SSH transport — see
  `commands/terminal/README.md`). Small files may ride REST-API file endpoints.
- Honor the same `<router>` resolution, envelope, and settings as every other
  command; large transfers are exempt from the REST 60s timeout cap because they
  do not run over REST.

## Transfer methods (grounding)

RouterOS exposes several file paths; centrs prefers the secure, always-available
ones and treats the rest as explicit opt-ins:

| Method | Notes |
| ------ | ----- |
| `scp` | Over SSH. TIKOCI has existing code for this; the default once SSH lands. Depends on SSH key/login working. |
| `sftp` | Also over SSH. Open question whether it is easier/more robust for us than `scp`. |
| `ftp` | Enabled by default on RouterOS but **insecure**. Gate behind an explicit opt-in (e.g. `ALLOW_UNSAFE_PROTOCOLS=ftp`) so it is never silently chosen. |
| REST-API files | Small files only; rides `www`/`www-ssl`, subject to the REST 60s cap. |
| `/system/smb` | Supported by RouterOS but not enabled by default; unlikely an early target. |
| `rose-storage` (`rsync`/`nfs`/`nvme-over-tcp`/`iscsi`) | Require the `rose-storage.npk` package and explicit configuration; far-future, behind explicit `--via`. Documented so users know the capability exists. |

## Open questions

- `scp` vs `sftp` as the default secure method.
- Whether to stress-test large copies in CI, or keep a small-file round-trip as
  the integration proof (the free CHR license caps throughput at 1 Mb/s).

Defer until the SSH transport is grounded.
