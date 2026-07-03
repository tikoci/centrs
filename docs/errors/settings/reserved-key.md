# `settings/reserved-key`

`settings set`/`reset` refused a credential-shaped or self-referential CENTRS_* key.

## Fix

`centrs settings set <attr> <value>` and `centrs settings reset <attr>` refuse
five keys outright: `password`, `username`, `cdb-password`, `skip-env-file`,
and `run-fast-integration` (the `settingsRefusedKeys` list in
`src/settings.ts`). Each is refused for a different reason, not a blanket
policy: `password`/`username` are credential-shaped and belong on the
`__default__` CDB record — run `centrs devices add __default__ --user …
--password …` instead of duplicating a secret into a second, unencrypted
file. `cdb-password` is the CDB's own decrypt password; writing it beside the
encrypted CDB it unlocks would defeat the encryption, so pass
`--cdb-password` per invocation or export `CENTRS_CDB_PASSWORD` in the
calling shell instead. `skip-env-file` is self-referential — a line in
`centrs.env` that says "ignore this file" is a no-op by construction, since
the file has to be read to find it. `run-fast-integration` is a CI/test
signal `bun run test:integration` sets, never a human preference.

`settings get`/`settings print` still work read-only on all five keys — this
error is specific to the write path (`set`/`reset`). A read of `cdb-password`
or `password` redacts the value rather than refusing outright; see
[`settings/unknown-key`](unknown-key.md) for the different case of a token
that isn't a recognized setting at all. See examples 17 and 29 in
`commands/settings/examples.md`, and
[`docs/CONSTITUTION.md`](../../CONSTITUTION.md) (Identity and CDB) for why
credentials route through `devices` rather than `centrs.env`.
