# `internal/unhandled`

A command failed with an error centrs has no code for. The message is in `summary`, and `cause` holds the original error when there is one.

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
