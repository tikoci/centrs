# `discover/failed`

`discover` failed for a reason with no more specific code. The summary holds
the underlying message. Without `--save`, the CDB was not touched. With
`--save`, each neighbor is saved on its own, so neighbors saved before the
failure stay in the CDB, and the error does not list them.

## Typical triggers

- An error with no code of its own while listening or decoding *(code)*.
  Socket errors have their own code,
  [`mndp/listen-failed`](../mndp/listen-failed.md).
- With `--save`, a CDB fault: a wrong `--cdb-password`, or a CDB that cannot
  be written *(code)*. Most of these arrive with their own `cdb/*` code.

## Fix

- Run `centrs discover` again; the listen window is short (`--timeout`,
  15 seconds by default).
- With `--save`, check `--cdb-file` and `--cdb-password`, and run
  `centrs devices list` to see which neighbors were saved before the failure.
  Running `discover --save` again skips the ones already saved.
- In an agent sandbox, see
  [`mndp/listen-failed`](../mndp/listen-failed.md).

## If this looks wrong

Every recurring cause should have its own code. Open an issue with the
command, the `--json` envelope and `centrs --version`. Remove passwords
(`--password`, `--cdb-password`) and other secrets from both first.

## Related

- [`mndp/listen-failed`](../mndp/listen-failed.md)
- [`mndp/malformed`](../mndp/malformed.md)
