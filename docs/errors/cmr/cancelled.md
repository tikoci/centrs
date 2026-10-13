# `cmr/cancelled`

The operation was cancelled before the command was sent to this CMR client, so
nothing ran on it.

## Typical trigger

The caller aborted (Ctrl-C, or an `AbortSignal` in the library) during
preflight or before this member's dispatch. Members that had already been sent
the command are reported as [`cmr/outcome-unknown`](./outcome-unknown.md)
instead, because cancelling does not stop a client script that has started.

## Fix

Re-run when ready.
