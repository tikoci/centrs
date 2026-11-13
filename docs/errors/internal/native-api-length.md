# `internal/native-api-length`

centrs could not encode a native-API word: its length was negative, not a whole number, or over the protocol's 32-bit limit. The word was not sent.

## What may have run

That depends on where it failed. If the command could have changed the
router, check its state before you run it again.

## Report it

This is a centrs bug. Open an issue with:

- the command, with passwords (`--password`, `--cdb-password`) and other
  secrets removed;
- the `--json` envelope, including `cause` when it has one;
- the text output with `--verbose`, when the command takes it;
- `centrs --version`, and how centrs was installed.

There is no `--bug-report` flag.
