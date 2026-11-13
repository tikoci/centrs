# `routeros/request-failed`

RouterOS refused a REST, SSH or MAC-Telnet request, and its message matches
no rule in centrs's mapping table. The command reached the router and was
refused; RouterOS's own words, in `summary` and `context.detail`, are the
reason. The same refusal over the native API is
[`routeros/api-trap`](api-trap.md).

## Emitted by

`retrieve`, `execute`, `api` and `transfer` over `--via rest-api`, and
`execute` over `--via ssh` or `--via mac-telnet`. Switching transport does not
help: RouterOS gives the same message on each.

## Context

- `detail`: RouterOS's message, verbatim. The `cause` holds it too.
- `httpStatus`, `status`, `path`, `host`, `port`: the REST request, when REST
  carried it.
- `via`: the transport.

## Typical triggers

- A required argument is missing: `/user add name=x group=full` with no
  `password` gives `missing =password=` *(CHR 7.25.1, REST)*.
- A script syntax error sent with `--no-validate`: `:put (1+` gives
  `syntax error (line 1 column 9)` *(CHR 7.25.1, REST)*. With validation on,
  the same input stops before sending as
  [`validation/syntax`](../validation/syntax.md).
- On SSH and MAC-Telnet, a printed `syntax error` or `expected end of command`
  line *(code)*. Other console output is treated as the command's result, not
  an error.

## Fix

Read the message: it usually names the argument, value or item that is wrong.
Fix that part of the command and run it again. Check the command first with
`centrs explain <router> '<command>'`, which asks the router.

## If this looks wrong

This code is a gap in centrs's mapping (`src/core/routeros-errors.ts`), not a
RouterOS fault class. When a message recurs, open an issue with the command,
the `--json` envelope (it carries `context.detail` and `cause`), the RouterOS
version and `centrs --version`, so the message can get its own code.
Remove passwords
(`--password`, `--cdb-password`) and other secrets from both first.

## Related

- [`routeros/api-trap`](api-trap.md): the native-API twin.
- [`routeros/command-failed`](command-failed.md): RouterOS's `failure:` and
  `error:` messages.
- [`routeros/invalid-value`](invalid-value.md),
  [`routeros/unknown-attribute`](unknown-attribute.md),
  [`routeros/unknown-path`](unknown-path.md): messages that are mapped.
