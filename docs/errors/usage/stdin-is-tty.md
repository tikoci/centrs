# `usage/stdin-is-tty`

A flag that reads its value from stdin (e.g. `--password-stdin`) was given
while stdin is a terminal.

`--password-stdin` exists for automation: the value arrives on fd 0 so it never
appears in argv or `ps`. centrs does not prompt for it at a terminal — waiting
on a keyboard with no prompt would look like a hang, and echoing a typed secret
would defeat the point. Interactive prompting is tracked separately.

## Fix

Pipe or redirect the value:

```bash
printf '%s' "$ROUTER_PW" | centrs devices add 192.0.2.5 --user admin --password-stdin
centrs devices add 192.0.2.5 --user admin --password-stdin < pw.txt
```

See [`commands/devices/README.md`](https://github.com/tikoci/centrs/blob/main/commands/devices/README.md)
for the record-password channels.
