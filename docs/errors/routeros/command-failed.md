# `routeros/command-failed`

A generic RouterOS command failure. RouterOS reports these as a `failure: <msg>`
string; the inner message is preserved in `context.failure` and the original
string in `context.detail`.

## Typical RouterOS strings

- `failure: <msg>` (for example, `failure: already have such entry`)

## Fix

Inspect the RouterOS failure message, then adjust the path, attributes, or
request shape accordingly.
