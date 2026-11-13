# `validation/option`

An option has a value centrs does not accept. centrs stopped before
connecting: nothing was sent.

## Emitted by

- `--resolve` on any command that takes it: only `none` (the default) and
  `arp` exist *(code; reproduced on the CLI)*.
- `btest`: a value out of range for the bandwidth-test wire format, a UDP
  packet size under 4 bytes, or `btest` server authentication with an empty
  user or password *(code)*.

## Context

- `option` or `resolve`: the option and the value that was refused.

## Fix

- `--resolve`: use `--resolve arp` to find a MAC target's IP address in the
  host ARP cache, or leave it out.
- `btest`: adjust the value as the summary says; `centrs btest --help` lists
  each option.

## Related

- [`input/invalid-command`](../input/invalid-command.md)
- [`target/mac-not-in-arp`](../target/mac-not-in-arp.md)
