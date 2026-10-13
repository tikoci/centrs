# `cmr/membership-changed`

The CMR client was validated, but before the command was dispatched it changed
or left the selection. The command was **not** sent to it.

## Typical trigger

- The client's labels changed, so `numbers=<id> labels=<expr>` at dispatch
  selected nothing (`failure: no devices selected`).
- Its `/cmr/device` row disappeared, or its `ids` key changed, between the
  validation pass and dispatch. centrs re-reads the inventory just before
  each member's own call, after any write prompt, so a client replaced
  while the prompt or the fan-out queue waited is caught here. A validation
  result belongs to the key it ran on, so it is not reused for a different one,
  and a replacement row is never adopted.

## Fix

Re-run. centrs validates the current selection again and only sends the
command to clients that passed validation in that run.
