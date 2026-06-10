# `routeros/btest-too-many-sessions`

The btest server refused a client because `max-sessions` is reached.

## Fix

Wait for an in-flight bandwidth test to finish, or start the centrs btest server
with a higher `--max-sessions` (RouterOS allows `1..1000`, default `100`). See
`commands/btest/README.md` and [`docs/CONSTITUTION.md`](../../CONSTITUTION.md).
