# check

Probe a router and report which management paths are usable.

Status: `not-started`. This file is a stub.

## Intent

- TCP reachability per protocol (rest-api, native-api, ssh).
- Auth check on whichever protocols answered.
- Optional `--via` to limit the probe surface.
- Output is the standard envelope; `data` is a per-protocol probe result map.

## Open questions

- Whether `check` should consult `/ip/service` once authenticated to reveal
  ports we did not try (the "discover open management ports" idea).
- Should L2 probing (mac-telnet ARP / discovery) be opt-in?

Defer until `retrieve` is `CHR-passed`. `check` overlaps with discovery and is
easier to design once name resolution lands.
