# `transport/tls-certificate`

The TLS connection to REST over HTTPS (`www-ssl`) or to `api-ssl` failed
certificate verification. centrs verifies peers by default.

## Typical triggers

RouterOS ships a self-signed certificate, which no system trust store accepts.
An expired certificate, or one whose name does not match the host you dialed,
fails the same way.

## Fix

- Install a certificate chain your machine trusts on the router, and dial the
  name it was issued for.
- Or accept the router's certificate: `--insecure`, `CENTRS_INSECURE=1`, or
  `insecure=true` in the device's CDB comment. The result then carries a
  [`transport/insecure-trust`](insecure-trust.md) warning.
- REST over plain HTTP (`http://host`) avoids TLS, but sends the credentials
  unencrypted.
