# `input/invalid-query`

A `--query` expression does not parse as a `print where` condition.

## When it happens

`retrieve --query` and `api --query` take what you would write after
`print where`: `name=ether1`, `mtu>=1500 and !dynamic`,
`(type=ether or type=vlan)`. centrs parses it before anything is sent, then
runs it on the router as an API query. The error's `context.offset` points at
the problem in `context.query`.

centrs also refuses spellings that RouterOS reads differently from how they
look, or does not accept:

- `!name=value` is `(!name)=value` to RouterOS, which matches by accident.
  Write `!(name=value)` or `name!=value`.
- `not` is not a RouterOS operator. Use `!`.
- Conditions separated only by a space. Join them with `and` or `or`.
- An unquoted `=` inside a value. RouterOS reads `comment=x=yes` as
  `(comment=x)=yes`, and `comment=x!=y` matches nothing. Quote it:
  `comment="x=yes"`.
- A space after the operator (`comment= x`), which RouterOS rejects too.
- A string escape RouterOS does not have, such as lowercase hex `\0a` (hex is
  two uppercase digits; `\ff` is `\f` then `f`), or a hex byte above `\7F`,
  which a UTF-8 query value cannot carry.

A bare name (`disabled`, `comment`) means what it means after `where`: `yes`
for a boolean and "is set" for anything else. Only the router knows which a
property is, so with `--validate=false` a bare name fails here too.

## Fix

- Quote values that contain spaces: `comment="uplink a"`.
- Close every `(` and `"`.
- Write a boolean out as `disabled=yes` if validation is off.
