# `routeros/api-trap`

RouterOS refused a native-API command with a `!trap`, and its message matches
no rule in centrs's mapping table. The command reached the router and was
refused; RouterOS's own words, in `summary` and `context.detail`, are the
reason. The same refusal over REST, SSH or MAC-Telnet is
[`routeros/request-failed`](request-failed.md).

## Emitted by

`retrieve`, `execute`, `api` and `transfer` over `--via native-api`, and
`execute --cmr` when the controller is reached over the native API. Switching
transport does not help: RouterOS gives the same message on each.

## Context

- `detail`: RouterOS's message, verbatim. The `cause` holds it too.
- `command`: the API command that trapped, such as `/user/add`.
- `message`: the `!trap` `=message=` attribute.
- `category`: the `!trap` `=category=` attribute, when RouterOS sends one.

## Typical triggers

- A required argument is missing: `/user/add =name=x =group=full` with no
  `password` traps with `missing =password=` *(CHR 7.25.1)*.
- A script syntax error sent with `--no-validate`: `:put (1+` gives
  `syntax error (line 1 column 9)` *(CHR 7.25.1)*. With validation on, the
  same input stops before sending as
  [`validation/syntax`](../validation/syntax.md).

A trap during login is not this code: it is
[`transport/auth-failed`](../transport/auth-failed.md).

## Fix

Read the message: it usually names the argument, value or item that is wrong.
Fix that part of the command and run it again. Check the command first with
`centrs explain <router> '<command>'`, which asks the router.

## If this looks wrong

This code is a gap in centrs's mapping (`src/core/routeros-errors.ts`), not a
RouterOS fault class. When a message recurs, open an issue with the command,
the `--json` envelope (it carries `context.detail` and `cause`), the RouterOS
version and `centrs --version`, so the message can get its own code.

## Related

- [`routeros/request-failed`](request-failed.md): the REST, SSH and
  MAC-Telnet twin.
- [`routeros/command-failed`](command-failed.md): RouterOS's `failure:` and
  `error:` messages.
- [`routeros/api-fatal`](api-fatal.md): RouterOS ended the whole session.
