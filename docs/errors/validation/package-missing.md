# `validation/package-missing`

This device has no such menu; MikroTik publishes it in a package that is likely
not installed.

RouterOS's `:parse` reports a menu it does not have as `syntax error` (slash
spelling, `/zerotier/print`) or `bad command name` (space spelling,
`/zerotier print`). Both point at the segment it could not resolve. centrs
looks that path up in its path catalog — every RouterOS 7.10–7.25 build, all
extra packages — and when MikroTik publishes it behind a package and nothing
else, reports this code instead of `validation/syntax`.

`error.context` carries:

- `path` — the absent menu, from the root (`/zerotier`). An abbreviated segment
  is expanded when the catalog has one unique completion.
- `segment` — the segment as written.
- `packages` — the published package names. These are MikroTik's build names
  and can differ from the installable package (`wireless-rep` ships in
  `wireless`, `userman-5` in `user-manager`).
- `gates` — every published gate on the path, root-first.
- `detail` — RouterOS's own words; `error.position` is its byte column.

## Fix

The command is not the problem. Check the installed packages with
`/system/package/print`, install the package and reboot, or run the command only
on devices that have it.
