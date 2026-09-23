# `cdb/file-exists`

`devices init` found a CDB already at the resolved location and wrote nothing.

This is a warning on a successful result, not an error. Like `git init`,
`centrs devices init` never overwrites an existing CDB. When the file there
already loads as a CDB, `init` succeeds with `data.created: false` and
`data.recordCount` set to the number of records it holds, and leaves the file
byte-for-byte untouched. A bootstrap script can therefore run `init`
unconditionally.

A file at that path that does not load as a CDB is not reported here. `init`
fails with the load error instead (`cdb/parse-failed`, or
`cdb/password-required` for an encrypted CDB without `--cdb-password`), and
still leaves the file alone.

## Fix

Usually nothing: the CDB you asked for exists.

- To see what it holds: `centrs devices list --cdb-file PATH`.
- To start fresh, pick a different path (`centrs devices init --cdb-file
  NEW_PATH`), or move the existing file aside yourself; centrs never deletes it.
