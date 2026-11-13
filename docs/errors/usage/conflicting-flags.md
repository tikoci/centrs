# `usage/conflicting-flags`

Two flags, or a flag and an argument, cannot be used together, or a flag is
missing the partner it needs. centrs stopped before connecting: nothing was
sent. The summary names the flags.

## Context

Depends on the flags: often `flag`, `conflicts`, or `machine` (a quickchr
name).

## Typical triggers

All *(code)*; the first three were reproduced on the CLI.

- `--quickchr` with a connection override (`--host`, `--port`, `--username`,
  `--password`, `--ssh-key`), a positional target, or a CDB selector.
  quickchr supplies all of those from the running VM.
- Two modes of one command: `retrieve --follow` with `--sample`, `--wait`
  with `--count`, `--list-attributes` with `--query`.
- A flag that only works with another: `--until` without `--wait`,
  `--labels` without `--cmr`, `--cursor` without `--complete`.
- `api` body sources together (`-f`, `-d`, `--input`), or a body on a request
  that cannot take one, such as a streamed `GET`.
- Selection flags that need one target: `--match` or `--cmr` with a fan-out,
  `--raw` with several targets.
- `transfer download` across several targets without `--out-dir`.

## Fix

Follow the remediation: it says which flag to drop or add. `centrs <command>
--help` lists each flag with the flags it needs or excludes.

## Related

- [`input/invalid-command`](../input/invalid-command.md): an unknown or
  malformed flag.
- [`usage/fanout-not-supported`](fanout-not-supported.md)
