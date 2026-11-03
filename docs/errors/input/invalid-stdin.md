# `input/invalid-stdin`

A flag that reads its value from stdin (e.g. `--password-stdin`) received
bytes that are not valid UTF-8 text, or began with a byte-order mark.

`centrs devices add`/`set --password-stdin` strips one trailing newline (`\n`
or `\r\n`) and decodes the rest as UTF-8. The CDB stores record strings as
UTF-8 and drops a leading byte-order mark (U+FEFF) when it reads them back, so
malformed bytes or a BOM would store a credential different from what was
piped in. centrs refuses instead of guessing. The bytes are never echoed.

## Fix

Pipe the password as plain UTF-8 text:

```bash
printf '%s' "$ROUTER_PW" | centrs devices set 192.0.2.5 --password-stdin
```

If the value comes from a file an editor saved with a BOM (common on Windows),
re-save it as UTF-8 without BOM, or strip the first three bytes:

```bash
tail -c +4 pw.txt | centrs devices set 192.0.2.5 --password-stdin
```

See [`commands/devices/README.md`](https://github.com/tikoci/centrs/blob/main/commands/devices/README.md)
for the record-password channels.
