# `transport/dns`

The host name could not be resolved, so nothing was dialed.

## Typical triggers

- A typo in `<router>` or `--host`.
- A CDB `target` that holds a DNS name your machine cannot resolve (a name
  that only the router's own DNS or a VPN knows).
- No working resolver on this machine.

## Fix

- Check the spelling, and resolve it yourself (`dig <name>`).
- Use a literal address: `--host 192.0.2.1`.
- `centrs devices show <router>` shows the CDB record's `target`. A record
  can also be matched by its comment keys `identity=`, `mac=` and `ip=`.
