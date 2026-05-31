# `target/mac-not-in-arp`

`--resolve arp` was requested for a MAC-address target, but that MAC is not
present in the host ARP cache, so it could not be resolved to an IP.

The ARP cache only holds entries for neighbors the host has communicated with
recently. A device that has not been contacted yet — or is on a different L2
segment — will not appear.

## Fix

- Make the device reachable first (for example, `ping` its IP, or run
  `centrs discover`) so the host learns its MAC → IP mapping, then retry, or
- Pass the IP address or hostname directly instead of the MAC.
