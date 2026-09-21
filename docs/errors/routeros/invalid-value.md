# `routeros/invalid-value`

RouterOS rejected a supplied value. When RouterOS names the offending argument,
it is captured in `context.argument`.

## Typical RouterOS strings

- `invalid value for argument <name>`
- `invalid value of <name>`
- `input does not match ...`

## Fix

Supply a value that matches the argument's expected type/format for this
RouterOS path.
