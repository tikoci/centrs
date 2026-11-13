# `input/invalid-command`

The command line or request was malformed: an unknown command, sub-command or
flag, or an argument that is missing or invalid. centrs stopped before
connecting: nothing was sent.

## Context

Depends on the trigger: an unknown flag carries `flag` and `suggestions`; a
missing target carries `missingTarget` and `command`.

## Typical triggers

- An unknown flag, usually a typo. centrs suggests the nearest one:
  `--attribtue` gives "Did you mean --attribute?" *(code; reproduced on the
  CLI)*.
- A flag the installed centrs does not have yet. An agent ran
  `centrs devices init --encrypt` on an old global install that predates the
  flag *(field)*.
- A missing argument: no target, no RouterOS path, no command string, or no
  `transfer` verb *(code)*.
- A command that was renamed or removed: `centrs stream` is now
  `centrs api … --stream` *(code)*.
- Over MCP, a tool call with a missing or malformed argument, such as both
  `target` and `group`, or a `where` clause that is not `attr=value` *(code)*.

An unknown top-level command is reported before flags are read, so it prints
as text even with `--json`.

## Fix

- Run `centrs <command> --help` and compare.
- If the flag is in the docs but centrs rejects it, check which centrs runs
  and its version: `which -a centrs` and `centrs --version`. A global
  install can be older than the docs you are reading. Update it, or run the
  release directly with `bunx @tikoci/centrs@latest`.

## If this looks wrong

If the flag is in `centrs <command> --help` and is still rejected, open an
issue with the command line, the `--json` envelope and `centrs --version`.
Remove passwords
(`--password`, `--cdb-password`) and other secrets from both first.

## Related

- [`usage/conflicting-flags`](../usage/conflicting-flags.md)
- [`usage/removed-flag`](../usage/removed-flag.md)
- [`usage/missing-flag-value`](../usage/missing-flag-value.md)

<!-- cspell:ignore attribtue -->
