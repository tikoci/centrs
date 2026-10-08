# `internal/byte-string`

A binary RouterOS word held a character that is not a byte.

## Fix

This is a centrs bug; report it with the command that triggered it.

`transfer` moves `/file` contents over REST and native-api as byte strings,
one string code unit per byte (#404). A code unit above U+00FF has no single
byte, so centrs refuses the request before it reaches the router rather than
silently keeping the low byte. See
[`docs/CONSTITUTION.md`](../../CONSTITUTION.md) for the centrs error contract.
