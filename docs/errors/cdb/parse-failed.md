# `cdb/parse-failed`

The CDB file was read, but its bytes are not a WinBox CDB centrs can decode.
Nothing was written, and no router was contacted.

## Context

- `cdbFile`: the file that failed.
- `parseKind`, `parseOffset`, `parseStructure`: where decoding stopped, when
  known. A file that is not a CDB at all reports `unsupported-magic` at
  offset 0 *(code; reproduced with a scratch file)*.

## Typical triggers

- `--cdb-file` points at some other file *(code)*.
- A truncated or damaged CDB, for example from a copy cut short *(code)*.
- An encrypted CDB whose decrypted bytes are malformed *(code)*. With a wrong
  password, centrs usually reports
  [`cdb/decrypt-failed`](decrypt-failed.md) instead.

## Fix

- Check the path in `context.cdbFile`.
- Restore the CDB from a backup, if there is one. Before most changes,
  `devices` writes one next to the CDB (`<cdb>.bak.<timestamp>`) and keeps the
  newest two. There is none for a CDB centrs has never written, and
  `devices encrypt --no-backup` writes none.
- If WinBox opens the file and centrs does not, open an issue with
  `context.parseKind`, `parseOffset`, `parseStructure` and `centrs --version`.
  Do not attach the CDB: it holds credentials.

## Related

- [`cdb/decrypt-failed`](decrypt-failed.md)
- [`cdb/not-found`](not-found.md)
