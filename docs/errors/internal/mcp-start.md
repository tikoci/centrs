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

- the command;
- the `--json` envelope, including `summary`, `context` and `cause`;
- the text output with `--verbose`, when the command takes it;
- `centrs --version`, and how centrs was installed.

Before you post, read every one of these and remove passwords
(`--password`, `--cdb-password`, `CENTRS_PASSWORD`), keys, tokens and any
other secret. centrs does not redact them for you: `summary` and `cause`
keep the original error text, and the envelope can carry the command or
script you ran. There is no `--bug-report` flag.
