# transfer

Copy files to and from a RouterOS device.

Status: `not-started`. This file is a stub. `transfer` appears in the
constitution's protocol-selection table (`ssh`/`scp` preferred; small REST-API
file ops as a fallback) but has no matrix grid row yet.

## Intent

- Default to `sftp` over SSH (lands with the SSH transport — see
  `commands/terminal/README.md`). sftp rides the same username/password centrs
  resolves from the CDB — RouterOS's SSH server supports the SFTP subsystem
  (MikroTik's own container docs transfer files this way) — so the default needs
  no per-router SSH key; `ssh-key=` stays an optional override and `scp` an
  explicit `--via`. Small files may ride REST-API file endpoints.
- Honor the same `<router>` resolution, envelope, and settings as every other
  command (see [`docs/CONSTITUTION.md`](../../docs/CONSTITUTION.md) for
  identity/CDB resolution and the result envelope); large transfers are exempt
  from the REST 60s timeout cap because they do not run over REST.

## Transfer methods (grounding)

RouterOS exposes several file paths; centrs prefers the secure, always-available
ones and treats the rest as explicit opt-ins:

| Method | Notes |
| ------ | ----- |
| `sftp` | **Default.** Over SSH; works with the CDB username/password — RouterOS supports the SFTP subsystem. |
| `scp` | Over SSH; explicit `--via` alternative. TIKOCI has existing scp code; handy when key-based auth is already set up. |
| `ftp` | Enabled by default on RouterOS but **insecure**. Gate behind an explicit opt-in (e.g. `ALLOW_UNSAFE_PROTOCOLS=ftp`) so it is never silently chosen. |
| REST-API files | Small files only; rides `www`/`www-ssl`, subject to the REST 60s cap. |
| `/system/smb` | Supported by RouterOS but not enabled by default; unlikely an early target. |
| `rose-storage` (`rsync`/`nfs`/`nvme-over-tcp`/`iscsi`) | Require the `rose-storage.npk` package and explicit configuration; far-future, behind explicit `--via`. Documented so users know the capability exists. |

## Decided (2026-06-06)

- **`sftp` is the default secure method** (not `scp`): it uses the
  username/password centrs already resolves from the CDB, and RouterOS supports
  the SFTP subsystem, so the common case works without a per-router SSH key.
  Both ride SSH and both accept password or key auth; `scp` stays an explicit
  `--via` and `ssh-key=` an optional override.
- **CI proof is a small-file round-trip**, not a large-copy stress test — the
  free CHR license caps throughput at 1 Mb/s, so stressing throughput buys
  nothing.

Implementation still defers until the SSH transport is grounded.
