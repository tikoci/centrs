# `cmr/outcome-unknown`

`execute --cmr` sent the command to a CMR client, but no final status came back
for it. The command **may have run, may still be running, or may not have
run**.

## Typical trigger

- CMR reported `failed` with `timed out (6)` (the `timeout=` centrs passes, from
  `--timeout`) or `std failure: timeout (13)` (CMR's own ~60 s ceiling per call).
- centrs stopped waiting: its local deadline passed, the operation was
  cancelled, or the controller connection dropped after the request was sent.
- The client changed its CMR key (`ids`) during the call.

On RouterOS 7.26beta1, a timed-out or cancelled `run-script` **kept running on
the client**, and its side effects landed afterwards (#441, #450). A timeout is
not a rollback.

## Fix

- Check the client's state before doing anything else. Read the menu the
  command changed, directly or through the controller.
- Do not re-run a command that is not idempotent until you know it did not run.
  centrs never retries a CMR dispatch.
- For long work, raise `--timeout` (up to 55 s per call). Anything needing more
  than CMR's ~60 s ceiling belongs in a script or scheduler entry on the client.

See [`commands/execute/README.md`](../../../commands/execute/README.md) → CMR.
