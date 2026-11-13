# `transport/insecure-trust`

A warning: `--insecure` is set, so TLS certificates and SSH host keys are
not verified for this transfer. The transfer ran.

## Emitted by

`transfer` with `--insecure`, or with the `insecure` device property set
*(code)*. A provider that already trusts the peer, such as a quickchr VM,
reports [`transport/provider-trust`](provider-trust.md) instead.

## Why it matters

Without peer verification, a machine in the path can pose as the router and
read the password and the file. `--insecure` is for labs and self-signed
certificates you have checked another way.

## Fix

- Install a certificate the client trusts on the router's `www-ssl` or
  `api-ssl` service, then drop `--insecure`.
- For SSH, accept the host key once, after you have checked it, and drop
  `--insecure`.

## Related

- [`transport/tls-certificate`](tls-certificate.md)
- [`transport/host-key-mismatch`](host-key-mismatch.md)
- [`transport/provider-trust`](provider-trust.md)
