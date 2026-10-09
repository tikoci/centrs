# `input/unsupported-query`

A `--query` uses something the RouterOS API query cannot run.

## When it happens

`--query` runs on the router as an API query (native `?` words, REST
`.query`), and that query language has no regex (`~`), no prefix membership
(`in`), and no script evaluation. A value starting with `$`, `[` or `{`, or a
`$` inside a quoted value, would need RouterOS's script evaluator. centrs
refuses these rather than filtering some other way and calling it a router
filter.

## Fix

- Read the rows without that condition and filter them yourself.
- Or run the console form, which returns console text rather than rows:
  `centrs execute <router> '/ip/address/print where interface~"^ether"'`.
- For a literal `$` in a quoted value, escape it as `\$`.
