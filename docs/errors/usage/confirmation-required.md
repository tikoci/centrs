# `usage/confirmation-required`

A command that changes something needs an explicit yes, and none was given.
centrs stopped before running it: nothing was changed.

This is the write gate. It is how a script or an agent says "I reviewed this
and mean it". It is not a permission check; the router's own user policy
still applies.

## Emitted by

- `execute`, when any statement in the command is write-shaped: any verb that
  is not a read (`print`, `get`, `export`, `find`, `monitor` and the like),
  an unknown menu, or a `file=` output *(code)*.
- `api`, for any method but `GET`, except on a path ending in `/print`,
  `/get` or `/listen`, or a `POST` to `/console/inspect` *(code)*.
- A `transfer` fan-out that writes: `upload`, `remove`, `mkdir` or `copy`
  *(code)*.
- Fan-outs and `execute --cmr`, with the number of routers in the summary
  *(code)*.
- MCP: `centrs_execute`, and the `centrs_devices` writes (`add`, `set`,
  `remove`) *(code)*.

## Context

- `command`, `path`, `verb`, `method`, `via`: what would have run.
- `routers`: how many routers a fan-out would reach.

## Fix

- Read what would run (the summary, and `context`), then repeat the command
  with `--yes`.
- At a terminal, centrs asks instead; type `yes` to continue.
- Over MCP, repeat the tool call with `confirm: true`. A RouterOS write over
  MCP also needs the device's `mcp=rw` property; without it the call fails as
  [`cdb/write-not-permitted`](../cdb/write-not-permitted.md).
- If centrs took a read for a write, that is a centrs bug in its read-verb
  list. Open an issue with the command and `centrs --version`, with
  passwords and other secrets removed from the command.

## Related

- [`cdb/write-not-permitted`](../cdb/write-not-permitted.md)
- [`transport/write-outcome-unknown`](../transport/write-outcome-unknown.md):
  a confirmed write whose result never came back.
