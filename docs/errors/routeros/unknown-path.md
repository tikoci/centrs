# `routeros/unknown-path`

RouterOS has no command at the requested path, so it refused that
statement. Either a menu in the path does not exist, or the menu exists but
has no such command (verb). A single command did not run; in a
multi-statement script, the statements before the refused one already ran.

## Emitted by

`retrieve`, `execute`, `api` and `transfer` over `--via rest-api` and
`--via native-api`, and `execute` over `--via ssh` and `--via mac-telnet`.
RouterOS gives the same answer on each transport, so switching does not help.
With validation on, most unknown paths stop before sending as
[`validation/unknown-path`](../validation/unknown-path.md); this code is what
the router itself says, for example with `--no-validate`.

## Context

- `detail`: RouterOS's message, verbatim.
- `httpStatus`, `status`, `path`: the REST request, when REST carried it
  (HTTP 400).

## Typical triggers

- An unknown menu: `/nosuch/thing/print` gives `no such command prefix` on
  the native API and `no such command or directory (nosuch)` over REST
  *(CHR 7.25.1)*.
- A verb the menu does not have: `/system/script/nosuch`, or `print` under a
  command such as `/system/reboot/print`, gives `no such command` on both
  transports *(CHR 7.25.1)*.
- A menu path with no verb: `execute '/system/identity'` gives
  `no such command` on the APIs, with
  `tip/execute-bare-menu-path` naming the read *(CHR 7.25.1)*.
- On the console transports, `bad command name …` with its
  `(line N column M)` position *(code)*.
- A menu from a package that is not installed, such as `/cmr/device` without
  the `cmr` package *(CHR 7.24.5)*. With validation on, this stops before
  sending as [`validation/package-missing`](../validation/package-missing.md).

## Fix

1. Check the path and verb with `centrs explain <router> '<command>'`, which
   asks the router's command tree. A menu path alone is not a command: add a
   verb such as `print`, or read the menu with
   `centrs retrieve <router> <menu>`.
2. If the menu belongs to a package, check `/system/package` on the device.
3. Before running a script again, check what its earlier statements changed:
   a rerun repeats them.

## Related

- [`routeros/no-such-item`](no-such-item.md): the path exists, but the item
  named does not.
- [`validation/unknown-path`](../validation/unknown-path.md): the same fault,
  caught before sending.
- [`routeros/unknown-attribute`](unknown-attribute.md): the command exists,
  but a parameter name does not.
