# `transport/connection-refused`

The device (or something in front of it) refused the TCP connection: nothing
is listening on that port, the RouterOS service is disabled, or a firewall
rejects it. No command reached RouterOS.

## Typical triggers

- REST (`rest-api`): the `www` / `www-ssl` service is disabled, or the port is
  wrong. REST rides the web service, 80 for HTTP and 443 for HTTPS.
- Native API (`native-api`): the `api` service (8728) or `api-ssl` (8729) is
  disabled.
- SSH (`ssh`, sftp `transfer`, `terminal`): the `ssh` service (22) is
  disabled.
- A port forward or local tunnel (for example a quickchr VM) points at the
  wrong guest port.

`context.host`, `context.port` and `context.via` name what was dialed.

## Fix

- Check the services: `/ip service print` on the router. Enable the one you
  need (`/ip service enable api`) and confirm its port and `address=` list.
- Pin the port that is open: `--port`, or a per-service CDB key such as
  `api-port=` or `www-ssl-port=`.
- Try another transport: `--via native-api`, `--via rest-api` or `--via ssh`.
- `centrs <command> … --verbose` shows which setting chose the host, port and
  transport (`meta.settings`).
