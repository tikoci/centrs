# `quickchr/unsupported-via`

The quickchr machine resolved fine, but the chosen `--via` has no usable
service on it. The descriptor is per-service; centrs reads exactly the
endpoint for the chosen protocol and never falls back to another transport.

## Typical trigger

Any of:

- The `--via` is a protocol the descriptor does not forward. quickchr v1
  forwards `rest-api`, `native-api`, and `ssh` only — `mac-telnet`, `romon`,
  `btest`, and `winbox-terminal` are never available on a quickchr target.
- The service exists but quickchr marked it `available: false` (the error
  carries the provider's `unavailableReason`).
- `--via ssh` (or `transfer --via sftp`/`scp`): the SSH endpoint reports no
  batch-capable auth mode (`batchModes` is empty), so a non-interactive
  handoff is impossible. centrs fails typed here rather than prompt for a
  password or silently pick another transport.

## Fix

- Pick one of the machine's live services; the error's `availableServices`
  context lists them (typically `--via rest-api` / `--via native-api` /
  `--via ssh`).
- For the SSH/sftp gate, verify key-based login works from quickchr's side
  (`quickchr ssh <name>`); once quickchr has a verified key, the descriptor
  advertises `private-key` in `batchModes` and centrs will use it.
- If the machine should be forwarding the service but is not, inspect it with
  `quickchr inspect <name>`.
- To use a transport quickchr does not forward, target the device directly
  (`--host`/CDB record) instead of `--quickchr`.

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) → Resolution providers for
why a provider's missing service is a typed error, never a silent fallback.
