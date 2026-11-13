# `internal/mcp-start`

`centrs mcp` failed to start. The message is in `summary`. No MCP session began, so nothing was sent to any router.

## First check

Check the flags with `centrs mcp --help`, and the CDB path and password the server is given.

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
