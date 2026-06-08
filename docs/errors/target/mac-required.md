# `target/mac-required`

The chosen Layer-2 transport — **mac-telnet** — addresses devices by MAC
address, but no MAC could be resolved for the target.

## When it happens

- `--via mac-telnet` (or the mac-telnet default for a bare-MAC target) was
  selected, but the `<router>` argument is not a MAC and resolves to no CDB
  record carrying a MAC.
- The matched CDB record has only an IP/DNS `target` and no `mac=` comment-kv
  lookup key, so there is no MAC to address.

## Fix

- Pass the device MAC directly: `centrs execute aa:bb:cc:dd:ee:ff '<command>' --via mac-telnet`.
- Or add a `mac=aa:bb:cc:dd:ee:ff` lookup key to the device's CDB comment so it
  is resolvable by identity/IP over L2.
- Or, if you actually want IP-level execution, pin an IP transport and resolve
  the MAC via ARP: `--via native-api --resolve arp` (or `--via rest-api`).

The `host`/`port` for mac-telnet are only the UDP delivery endpoint (default L2
broadcast); the MAC is the device identity.
