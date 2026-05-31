# `routeros/unknown-attribute`

RouterOS rejected an attribute (parameter) name it does not recognize for the
target path. The offending name is captured in `context.parameter`.

## Typical RouterOS strings

- `unknown parameter <name>`

## Fix

Remove or rename the attribute; use `--list-attributes` to see the parameters
this RouterOS path accepts.
