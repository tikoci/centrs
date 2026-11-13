# `input/mac-address`

A value that must be a MAC address is not one: it needs six hex octets. Nothing
was sent.

## Emitted by

`execute --via mac-telnet` and `terminal` *(code)*.

## Typical triggers

- A malformed `--source-mac` *(code)*.
- A library caller passing a malformed MAC to the MAC-Telnet adapter
  *(code)*.

A `<router>` that is not a MAC is treated as a host name or address, not
refused with this code.

## Fix

Write the MAC as six hex octets of one or two digits, separated by `:`, `-`
or `.`, for example `aa:bb:cc:dd:ee:ff` or `8a:6:1c:a:2:1f`.

## Related

- [`target/mac-unresolved`](../target/mac-unresolved.md)
- [`routeros/mac-telnet-protocol`](../routeros/mac-telnet-protocol.md)
