# `internal/unhandled`

A command failed with an error centrs has no code for. The message is in
`summary`, and `cause` holds the original error when there is one.

## What may have run

That depends on where it failed: before connecting, nothing ran; after a
command was sent, it may have run. If the command could change the router,
check its state before you repeat it.

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
