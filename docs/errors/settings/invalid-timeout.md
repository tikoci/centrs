# `settings/invalid-timeout`

A timeout setting received an invalid value.

## Fix

`centrs settings set timeout <value>` throws this when `<value>` doesn't
match the shared duration grammar (`parseDuration` in
`src/resolver/settings.ts`): a bare integer (milliseconds) or an integer
with a `ms`/`s`/`m` suffix — `500ms`, `5s`, `1m`. Anything else, like
`not-a-duration` (example 22 in `commands/settings/examples.md`), fails.
`settings.ts` layers one more rule on top for `timeout` specifically: even a
syntactically valid duration that parses to `0` is rejected — a zero timeout
isn't a meaningful value to set.

Like the other typed-value codes here, this isn't `settings`-exclusive:
`parseDuration` backs `CENTRS_TIMEOUT` and every command's own `--timeout`
flag, so the same failure shape shows up anywhere a duration string is
resolved, not just through `settings set`.

One write detail worth knowing: `settings set timeout` writes the
**canonical parsed milliseconds**, not the raw suffixed string you typed —
`centrs settings set timeout 5s` writes `CENTRS_TIMEOUT=5000` to
`centrs.env`, not `CENTRS_TIMEOUT=5s`. See
[`docs/CONSTITUTION.md`](../../CONSTITUTION.md) (Settings precedence) for how
this value feeds into the resolver chain.
