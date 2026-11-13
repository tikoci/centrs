# `internal/mcp-start`

`centrs mcp` failed to start. The message is in `summary`.

## First check

Check the flags with `centrs mcp --help`, and the CDB path and password the
server is given.

## What may have run

Nothing: no MCP session began, so no tool ran and nothing was sent to a
router.

## Report it

This is a centrs bug. Open an issue with:

- the command, with its flags;
- the error text `centrs mcp` printed to stderr. It has no `--json` form; if
  an MCP client started it, the text is in that client's server log;
- `centrs --version`, and how centrs was installed.

Before you post, read every one of these and remove passwords
(`--password`, `--cdb-password`, `CENTRS_PASSWORD`), keys, tokens and any
other secret. centrs does not redact them for you: the error text keeps the
original message, and the command line can carry a password. There is no
`--bug-report` flag.
