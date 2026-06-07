# check

Probe a router and report which management paths are usable.

Status: `not-started`. This file is a stub.

## Intent

- TCP reachability per protocol (rest-api, native-api, ssh).
- Auth check on whichever protocols answered.
- Optional `--via` to limit the probe surface.
- Output is the [standard envelope](../../docs/CONSTITUTION.md#result-envelope);
  `data` is a per-protocol probe result map.
- `--fix` (opt-in, write-shaped): once `check` has authenticated over *one*
  protocol, it reads the live device to **correct stale CDB connection
  metadata** — most usefully ports. E.g. reached over MAC/mac-telnet, it can read
  `/ip/service` to learn the real REST/native-API ports and write `port=` into
  the record's comment-kv so later calls connect directly. `--fix` writes through
  the `devices` layer (the only CDB writer) and is gated like any write
  (`--yes` / `confirm`). It corrects *connection* facts only; it is not a
  general fact-sync.

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

- `--fix` decided in principle (above): consult `/ip/service` once authenticated
  to learn non-default ports and write them back as comment-kv. Residual: exactly
  which fields `--fix` is allowed to touch (ports yes; what else?) and whether it
  ever runs implicitly vs always opt-in (lean: always opt-in).
- centrs does **not** make `check` persist version/board/software-id — those are
  device *facts* that become queryable through the derived-fact keys on the
  record (see `commands/devices/README.md`), refreshed on `devices add/set
  --check` or `discover`, not as a `check` side effect.
- Should L2 probing (mac-telnet ARP / discovery) be opt-in?

Defer until `retrieve` is `CHR-passed`. `check` overlaps with discovery and is
easier to design once name resolution lands.
