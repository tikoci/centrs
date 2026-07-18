# `quickchr/machine-stopped`

The named quickchr machine exists but is not running, so it has no live
connection facts (host, forwarded ports, credentials) for centrs to dial.

## Typical trigger

`--quickchr <name>` named a real machine, but its VM is stopped. quickchr only
knows the forwarded loopback ports and running-state auth while the machine is
up, so a stopped machine cannot yield a `ServiceEndpointMap`.

## Fix

- Start it: `quickchr start <name>`, then retry `--quickchr <name>`.
- Confirm state with `quickchr list` / `quickchr inspect <name>`.

This is a per-target failure: in a fan-out over several `--quickchr` targets,
one stopped machine fails only its own row, not the whole run.

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) → Resolution providers.
