# `input/invalid-routeros-path`

The RouterOS path is malformed: not slash-prefixed, a segment that is not a
menu name, or characters a REST URL would reinterpret.

## Typical triggers

- A path without a leading slash: `retrieve <router> ip/address`.
- A `retrieve` or `api` path segment that is not a RouterOS menu name. Menu
  names are letters, digits and hyphens (case folds) (`/interface/6to4`,
  `/ip/dhcp-server`). The check runs on every transport and even with
  `--validate=false`, because a read must only dispatch a read (#586).
- A REST request path containing `?`, `#`, `\`, a control character, or a
  `.`/`..` segment, including percent-encoded forms such as `%2e%2e`. The
  URL parser would turn these into a query, a fragment
  or a different path, so the request would not reach the path as written.
  Before this guard, `retrieve '/system/reboot#' --no-validate` posted
  `/rest/system/reboot`.

`context.path` names the path; `context.invalidSegments` lists the segments
that failed the menu grammar.

## Fix

- Write the path as slash-separated menu names: `/ip/address`,
  `/system/resource`.
- Select rows with `--query` (for example `--query 'name="a#b"'`), not with
  characters in the path.

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) for the centrs error
contract.
