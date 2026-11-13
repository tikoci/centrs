# `routeros/api-trap`

RouterOS answered a native-API command with a `!trap`, and its message
matches no rule in centrs's mapping table. RouterOS's own words, in
`summary` and `context.detail`, are the reason. The command reached the
router and may have partly run: anything before the error stays applied.
The same error over REST, SSH or MAC-Telnet is
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
- A script that stops on an error after earlier steps ran: a script whose
  source is `/interface/bridge/add comment=x; :error "stop"`, run with
  `/system/script/run`, traps with `stop`, but the bridge already exists. A
  rerun adds a second bridge *(CHR 7.25.1)*.

A trap during login is not this code: it is
[`transport/auth-failed`](../transport/auth-failed.md).

## Fix

- Read the message: it usually names the argument, value or item that is
  wrong, or the point where a script stopped.
- Before you run a write again, check the router's state and undo or skip
  what already ran. A rerun repeats every step before the error.
- Fix that part of the command, check it with
  `centrs explain <router> '<command>'`, which asks the router, and run it
  again.

## If this looks wrong

This code is a gap in centrs's mapping (`src/core/routeros-errors.ts`), not a
RouterOS fault class. When a message recurs, open an issue with the command,
the `--json` envelope (it carries `context.detail` and `cause`), the RouterOS
version and `centrs --version`, so the message can get its own code. Remove
passwords (`--password`, `--cdb-password`) and other secrets from both first.

## Related

- [`routeros/request-failed`](request-failed.md): the REST, SSH and
  MAC-Telnet twin.
- [`routeros/command-failed`](command-failed.md): RouterOS's `failure:` and
  `error:` messages.
- [`routeros/api-fatal`](api-fatal.md): RouterOS ended the whole session.
