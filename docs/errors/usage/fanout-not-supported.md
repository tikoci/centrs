# `usage/fanout-not-supported`

The command or mode cannot fan out across multiple targets.

## Fix

Some surfaces are single-session by nature and reject a multi-target selection:

- `terminal` — an interactive console relay to one device.
- `api --stream` / `api --listen` — an open-ended native-api follow is a single
  long-lived subscription.

Run the command against a single target (one positional, no `--group` / `--where` /
`--all` / `--default`). To act on a fleet, use a fan-out-capable verb instead
(`retrieve`, `execute`, `api` without `--stream`, `transfer`). See
[`docs/CONSTITUTION.md`](../../CONSTITUTION.md) (Target selection).
