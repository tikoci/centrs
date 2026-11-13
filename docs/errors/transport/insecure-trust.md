# `transport/insecure-trust`

A warning: insecure mode is on, so this transfer does not verify TLS
certificates or SSH host keys when it connects. The warning reports that
setting, not an outcome: `ok` and `error` say whether the transfer worked.

## Emitted by

`transfer` with `--insecure`, `CENTRS_INSECURE`, `insecure` in
`centrs.env`, or the `insecure` device property set *(code)*. The message
names `--insecure` whichever source set it. A provider that already trusts the peer, such as a quickchr VM,
reports [`transport/provider-trust`](provider-trust.md) instead.

## Why it matters

Without peer verification, a machine in the path can pose as the router and
read the password and the file. `--insecure` is for labs and self-signed
certificates you have checked another way.

## Fix

First make verification pass:

- Install a certificate the client trusts on the router's `www-ssl` or
  `api-ssl` service.
- For SSH, accept the host key once, after you have checked it.

Then turn insecure mode off at every source that sets it:

- drop `--insecure`;
- unset `CENTRS_INSECURE`, and remove it from `centrs.env`
  (`centrs settings reset insecure`);
- remove the device property with `centrs devices set <router> insecure=`.

## Related

- [`transport/tls-certificate`](tls-certificate.md)
- [`transport/host-key-mismatch`](host-key-mismatch.md)
- [`transport/provider-trust`](provider-trust.md)
