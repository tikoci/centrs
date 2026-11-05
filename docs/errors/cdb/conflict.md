# `cdb/conflict`

The CDB changed after it was loaded; the stale write was refused so no change is lost.

## Typical trigger

Two writers loaded the same CDB, and the other one saved first. Every centrs
mutation (`devices add`/`set`/`remove`/`encrypt`, `discover --save`, the MCP
`centrs_devices` add/set/remove ops) records the revision of the file it loaded.
Under the CDB lock it re-reads the file and refuses to replace it when the
revision no longer matches. Without that check the second writer would silently
drop the first writer's change.

The CLI, MCP, and `discover --save` reload and replay the request (up to 5 attempts) on a
conflict, so you normally see this only when the CDB is changing continuously,
or when a library caller holds an old `LoadedCdb` snapshot.

## Fix

- CLI / MCP: retry the command. If it conflicts again, another writer is busy;
  wait for it to finish.
- Library: call `loadCdb()` again and re-apply your change to the fresh
  snapshot, or wrap the mutation in `retryOnCdbConflict()`.
- If WinBox has this file open, close it first. WinBox does not take the centrs
  lock, and while it is open it can save its in-memory list over your changes.
