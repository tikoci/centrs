# `transport/capability-unsupported`

The pinned transport cannot perform the requested kind of operation, and centrs
will not silently switch transports (see `docs/CONSTITUTION.md`, protocol
selection).

## When it happens

- A read/inspect operation was routed over **mac-telnet**, which is a console
  (execute/terminal) transport only — it has no structured `retrieve` or
  `/console/inspect` surface. centrs surfaces this rather than scraping the
  interactive console for structured data.
- More generally: a `--via` was pinned to a transport that lacks the capability
  the command needs.

## Fix

- For structured reads, use an IP transport: `--via rest-api` or
  `--via native-api` (add `--resolve arp` to reach a MAC target over IP).
- Use mac-telnet for `execute`/`terminal` (running CLI commands / an interactive
  console), not for `retrieve`.
- Drop the `--via` pin to let centrs auto-select a capable transport.
