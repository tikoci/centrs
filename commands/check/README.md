# check

Probe a router and report which management paths are usable.

Status: `not-started`. This file is a stub.

## Intent

- TCP reachability per protocol (rest-api, native-api, ssh).
- Auth check on whichever protocols answered.
- Optional `--via` to limit the probe surface.
- L2 probing (mac-telnet reachability / ARP) is **opt-in, off by default** —
  enabled by a MAC target, `--via mac-telnet`, or `--l2`. It needs L2 adjacency
  and is slower, so IP-level probing (rest/native/ssh) stays the default.
- Output is the [standard envelope](../../docs/CONSTITUTION.md#result-envelope);
  `data` is a per-protocol probe result map.
- `--fix` (opt-in, write-shaped): once `check` has authenticated over *one*
  protocol, it reads the live device and writes back through the `devices` layer
  (the only CDB writer), gated like any write (`--yes` / `confirm`). It refreshes
  two things in one authenticated pass:
  - **Connection metadata** — most usefully ports. Reached over MAC/mac-telnet,
    it reads `/ip/service` to learn the real REST/native-API ports and writes
    `port=` into the record's comment-kv so later calls connect directly.
  - **Derived facts** — `board`, `version`, `software-id`, plus the `updated=`
    stamp, from the same session (the same keys `devices add/set --check` and
    `discover --save` populate). These stay queryable-but-stale facts that never
    override a live read (see `commands/devices/README.md`, Derived facts).

  `--fix` is **always explicit**, never implicit; plain `check` (no `--fix`) is a
  pure read-only probe that writes nothing.

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

- `--fix` scope **decided** (above): connection metadata (ports) **plus** the
  derived facts (`board`/`version`/`software-id`/`updated=`), refreshed in one
  authenticated pass through the `devices` write layer; always explicit opt-in,
  never implicit. Plain `check` stays a read-only probe that writes nothing.
- L2 probing opt-in **decided** (Intent above): off by default; enabled by a MAC
  target, `--via mac-telnet`, or `--l2`.

Defer until `retrieve` is `CHR-passed`. `check` overlaps with discovery and is
easier to design once name resolution lands.
