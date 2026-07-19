# `quickchr/unsupported`

The installed `@tikoci/quickchr` cannot give centrs a usable descriptor: it is
too old to expose the descriptor API, it failed to load, or it emitted a
descriptor centrs cannot read.

## Typical trigger

Any of:

- The installed quickchr predates the `QuickCHR.get(name).descriptor()` API
  (before 0.4.4), so the descriptor entry point is missing.
- The package is installed but throws while loading (a broken/partial install),
  which is a real fault — distinct from
  [`quickchr/package-unavailable`](./package-unavailable.md), which means "not
  installed at all".
- The descriptor is malformed or pre-v1: no numeric `descriptorVersion`, no
  `services` map, or missing `name`/`version`/`arch`. centrs rejects it rather
  than crash on a later field access or silently treat `services` as empty
  (which would hide a provider contract violation).
- The descriptor version is **newer** than centrs supports
  (`descriptorVersion` > 1); a newer quickchr speaks a schema this centrs
  predates.

## Fix

- Upgrade quickchr to a release that emits descriptor v1: `bun add
  @tikoci/quickchr` (0.4.5+ — 0.4.4 has the API but a descriptor endpoint
  bug, quickchr#95).
- If the descriptor looks wrong, inspect the machine directly with `quickchr
  inspect <name>` — it may be in a transient state.
- If the descriptor is newer than centrs supports, upgrade centrs.

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) → Resolution providers for
the descriptor contract and the supported version boundary.
