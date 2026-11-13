# `internal/mcp-tool`

An MCP tool failed with an error centrs has no code for. The message is in
`summary`.

## What may have run

The tool may have sent a command to the router before it failed. If the call
could change the router, check its state before you repeat it. A
`centrs_devices` call changes only the local CDB.

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
