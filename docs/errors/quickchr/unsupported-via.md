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

An SSH endpoint that is forwarded but has no verified key is a separate code,
[`quickchr/ssh-auth-unavailable`](ssh-auth-unavailable.md).

## Fix

- Pick one of the machine's live services; the error's `availableServices`
  context lists them (typically `--via rest-api` / `--via native-api` /
  `--via ssh`).
- If the machine should be forwarding the service but is not, inspect it with
  `quickchr inspect <name>`.
- To use a transport quickchr does not forward, target the device directly
  (`--host`/CDB record) instead of `--quickchr`.

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) → Resolution providers for
why a provider's missing service is a typed error, never a silent fallback.
