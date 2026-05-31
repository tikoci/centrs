# `target/mac-unresolved`

The `<router>` target is a MAC address, but no CDB record matched it and host
ARP resolution was not requested, so it could not be turned into an IP-level
target.

centrs never silently scans the network: a MAC is resolved through the CDB
first, and only resolved via the local host ARP cache when you explicitly opt
in.

## Fix

- Pass an IP address or hostname instead of the MAC, or
- Add a CDB record for this MAC (so identity + credentials resolve), or
- Re-run with `--resolve arp` to resolve the MAC to an IP via the host ARP
  cache (for `execute`, also pin an IP transport with `--via native-api` or
  `--via rest-api`).
