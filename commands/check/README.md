# check

Probe a router and report which management paths are usable.

Status: `not-started`. This file is a stub.

## Intent

- TCP reachability per protocol (rest-api, native-api, ssh).
- Auth check on whichever protocols answered.
- Optional `--via` to limit the probe surface.
- Output is the [standard envelope](../../docs/CONSTITUTION.md#result-envelope);
  `data` is a per-protocol probe result map.

## Default service ports (grounding)

centrs assumes RouterOS defaults when a port is not overridden (CDB `port=` /
`--port`). Default `/ip/service` ports: `ftp` 21, `ssh` 22, `telnet` 23,
`www` 80 (often moved, e.g. 7080), `www-ssl` 443, `winbox` 8291, `api` 8728,
`api-ssl` 8729. (native API rides `api`/`api-ssl`; REST rides `www`/`www-ssl`.)

Once `check` (or any command) has authenticated access over *one* protocol, it
can read the live service map to discover non-default ports for *other*
protocols — e.g. reach a box over SSH, then learn the REST port without the user
specifying it, and "upgrade" the connection:

```routeros
:put [:serialize to=json options=json.pretty \
  [ip/service/print detail as-value where !dynamic ]]
```

## Open questions

- Whether `check` should consult `/ip/service` once authenticated to reveal
  ports we did not try (the "discover open management ports" idea — see the
  grounding above; the fetch command is known, the policy is not).
- Should L2 probing (mac-telnet ARP / discovery) be opt-in?

Defer until `retrieve` is `CHR-passed`. `check` overlaps with discovery and is
easier to design once name resolution lands.
