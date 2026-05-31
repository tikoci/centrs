# `routeros/unknown-path`

RouterOS did not recognize the command path or menu item that was requested.

## Typical RouterOS strings

- `no such command prefix`
- `no such item`
- `no such entry`
- path-shaped `... not found`

## Fix

Check the slash-prefixed RouterOS path against the device's command tree (use
`--list-attributes` or `--no-validate` to narrow the mismatch).
