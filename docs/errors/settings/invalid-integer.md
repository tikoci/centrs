# `settings/invalid-integer`

An integer setting received a non-integer or out-of-range value.

## Fix

`centrs settings set max-results <value>` and `centrs settings set port
<value>` both throw this when `<value>` fails the shared positive-integer
rule (`resolveOptionalIntegerSetting` in `src/resolver/settings.ts`):
`Number.isInteger(n) && n > 0`. `0`, negative numbers (`-1`), and
non-numeric strings (`abc`) are all rejected the same way — `centrs settings
set max-results 0` is the canonical trigger (example 20 in
`commands/settings/examples.md`).

This validator isn't specific to `settings` — `resolveOptionalIntegerSetting`
is the shared helper every `CENTRS_*` integer setting resolves through
(`max-results`, `port`, and any future integer key), so the same code and
message shape appear whenever an integer env var, CLI flag, or `centrs.env`
line resolves to a non-positive or non-numeric value anywhere in the app,
not only through `settings set`.

A failed `set` never partially writes; re-run with a positive integer. See
[`docs/CONSTITUTION.md`](../../CONSTITUTION.md) (Settings precedence) for how
this value feeds into the resolver chain.
