# `cdb/locked`

Another writer held the CDB lock past the wait timeout; nothing was written.

## Typical trigger

centrs serializes CDB writes with a sibling lock file, `<cdb>.lock` (for
example `~/.config/tikoci/winbox.cdb.lock`). A write waits up to 10 seconds for
another centrs process to release it. The error context names the lock file and
the holder's pid, host, and start time.

A lock left by a crashed centrs process on the same host is removed
automatically once its pid is no longer running. A lock from another host (a
CDB on a shared drive), an unreadable lock file, or a holder pid that the OS
reused for another process is never removed automatically.

Dead-lock recovery uses an OS-backed SQLite mutex on `<cdb>.lock.guard`.
That empty file persists; a crashed recovery process releases its mutex
automatically. Leave the guard file in place.

## Fix

- Wait for the other `centrs devices`/`discover --save`/MCP write to finish,
  then retry.
- If no centrs process is writing this CDB, the lock is left over from a crash:
  delete the lock file named in the error and retry. Deleting it while another
  writer is active can let that writer's change be lost.
