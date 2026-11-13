# `internal/native-api-length`

centrs could not encode a native-API word: its length was negative, not a
whole number, or over the protocol's 32-bit limit.

## What may have run

centrs encodes a whole command before sending it, so the command with that
word was not sent. Commands sent earlier on the same session did run.

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
