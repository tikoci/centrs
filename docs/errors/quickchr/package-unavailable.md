# `quickchr/package-unavailable`

The optional `@tikoci/quickchr` package is not installed, so a `--quickchr
<name>` target cannot be resolved into connection facts.

## Typical trigger

You passed `--quickchr <name>` (or otherwise resolved a quickchr target) in an
install that does not have `@tikoci/quickchr`. centrs declares it as an
**optional dependency** and loads it through a runtime import, so a normal
install without it works for every non-quickchr path and only fails here.

## Fix

- Install the package: `bun add @tikoci/quickchr` (0.4.4+ ships the descriptor
  v1 API centrs reads).
- Or bypass quickchr entirely and target the device directly with `--host`
  (plus `--username`/`--password`/`--ssh-key` or a CDB record).

This code is raised **only** when the module is genuinely not found. An
installed package that throws while loading reports
[`quickchr/unsupported`](./unsupported.md) instead, so the two are never
confused.

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) → Resolution providers for
the named-live-provider contract.
