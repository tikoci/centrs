# devices

List, inspect, and resolve RouterOS targets known to centrs.

Status: `not-started`. This file is a stub.

## Intent

`devices` is the user-facing surface over the device registry described in
`docs/CONSTITUTION.md`. It does not use a transport in the protocol sense; it
reads from:

- explicit input,
- environment variables,
- the CDB at `~/.config/tikoci/winbox.cdb` (or `--cdb-file`),
- the MNDP cache (once implemented),
- (later) `dude.db` import via `tikoci/donny`.

## Sketch

- `centrs devices list` — show known targets and their provenance per source.
- `centrs devices show <name|ip|mac>` — inspect one resolved target, including
  which source filled each field and why.
- `centrs devices groups` — list CDB groups (when CDB groups land).

## Open questions

- Output shape for "merged provenance" — likely a per-field source map.
- Whether `devices` should ever cause network IO (probably no; that's `check`).

Defer until name resolution + MNDP cache are in scope.
