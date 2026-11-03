# `input/empty-stdin`

A flag that reads its value from stdin (e.g. `--password-stdin`) received
nothing.

`centrs devices add`/`set --password-stdin` strips one trailing newline (`\n`
or `\r\n`) and refuses what is left if it is empty. An empty pipe is usually a
mistake — an unset variable, a missing file, a command that printed nothing —
so it is not treated as "clear the password".

## Fix

Pipe a non-empty value:

```bash
printf '%s' "$ROUTER_PW" | centrs devices set 192.0.2.5 --password-stdin
centrs devices set 192.0.2.5 --password-stdin < pw.txt
```

To clear a stored password on purpose, say so with the argv flag:

```bash
centrs devices set 192.0.2.5 --password ""
```

See [`commands/devices/README.md`](https://github.com/tikoci/centrs/blob/main/commands/devices/README.md)
for the record-password channels.
