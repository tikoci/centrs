# `validation/not-implemented`

**Retired.** centrs 0.1.8 and later never emit this code. The page stays
because the URL shipped.

centrs 0.1.0 through 0.1.7 returned it when `retrieve` was given `--filter`
or `--query`, before those flags were built. Nothing ran on the device.

## Fix

Upgrade centrs (`centrs --version` shows what runs; `which -a centrs` finds a
stale global install). From 0.1.8, `retrieve --query` (and `--filter`) run RouterOS's own
`print where` query on the device; see
[`commands/retrieve/README.md`](../../../commands/retrieve/README.md).
