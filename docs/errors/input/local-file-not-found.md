# `input/local-file-not-found`

centrs could not read a local file it was given. Nothing was sent.

## Emitted by

- `transfer upload`: the local source *(code)*.
- `api --input <file>`: the request body, or stdin with `--input -`
  *(code)*.
- `explain --file <file>` *(code)*.

## Context

- `local`, `input` or `path`: the file, depending on the command.
- `cause`: the operating-system error, such as a missing file or no read
  permission.

## Fix

- Check the path. A relative path is relative to the directory centrs runs
  in, which for an agent may not be the one you expect.
- Check read permission. In an agent sandbox, the file may be outside the
  directories the sandbox allows.

## Related

- [`usage/target-exists`](../usage/target-exists.md): the remote side of a
  transfer.
