# `settings/invalid-boolean`

A boolean-like setting received a non-boolean value.

## Fix

`centrs settings set <attr> <value>` throws this for the three boolean-typed
managed keys — `mcp-allow-adhoc`, `validate`, `insecure` — when `<value>`
isn't one of the spellings the shared parser (`parseBoolean` in
`src/resolver/settings.ts`) accepts: `true`/`false`, `yes`/`no`, `on`/`off`,
or `1`/`0`, case-insensitively. Anything else — `maybe`, `2`, an empty
string — fails with a remediation listing the accepted spellings.

This isn't a `settings`-only rule: `parseBoolean` backs every `CENTRS_*`
boolean setting across the app, so the same error and message shape appears
whenever any command resolves a boolean env var to an unrecognized value,
not just through `settings set`.

One canonicalization detail worth knowing even though it isn't what triggers
this error: once a boolean value *does* validate, `settings set` always
writes the canonical `1` or `0` to `centrs.env`, never `true`/`false` —
`CENTRS_MCP_ALLOW_ADHOC`'s reader in `src/mcp/config.ts` checks the literal
string `"1"` rather than reusing `parseBoolean`, so writing `1`/`0`
uniformly is what satisfies every reader. Retry `set` with one of the
accepted spellings above; see
[`docs/CONSTITUTION.md`](../../CONSTITUTION.md) (Settings precedence) for how
this value feeds into the resolver chain.
