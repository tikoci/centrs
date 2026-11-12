# `transport/host-key-mismatch`

The device's SSH host key does not match the key OpenSSH recorded for that
host in `known_hosts`. centrs uses the host `ssh`/`sftp` clients, which trust
a new host on first use and refuse a changed key.

## Typical triggers

- The router was reinstalled or reset, or its host key was regenerated.
- Another device now answers on that address (a reused IP, a moved port
  forward, a new quickchr VM on the same port).
- A machine in the path is impersonating the router.

## Fix

- Verify the device first. Then remove the stale entry:
  `ssh-keygen -R <host>` (`ssh-keygen -R '[<host>]:<port>'` for a
  non-default port) and connect again.
- `--insecure` skips the check for one call and adds a
  [`transport/insecure-trust`](insecure-trust.md) warning. It also accepts an
  impersonated key, so use it only on a lab target.
