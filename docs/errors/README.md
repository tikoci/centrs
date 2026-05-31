# centrs error pages

Each `CentrsError` carries a `details_url` of the form
`https://tikoci.github.io/centrs/errors/<code>`. This directory holds the
human-readable stub page for each code. The constitution requires one page per
error code (`docs/CONSTITUTION.md`, "Error URL scheme").

## `routeros/*` — RouterOS-surfaced errors

These codes are produced by the grounded vocabulary in
`src/core/routeros-errors.ts`, which maps the router's own error strings (REST
`detail` and native-api `!trap` message, identical on CHR 7.23) to one shared
table.

- [`routeros/unknown-path`](./routeros/unknown-path.md)
- [`routeros/unknown-attribute`](./routeros/unknown-attribute.md)
- [`routeros/invalid-value`](./routeros/invalid-value.md)
- [`routeros/session-closed`](./routeros/session-closed.md)
- [`routeros/command-failed`](./routeros/command-failed.md)

## `target/*` — target resolution errors

These codes are produced by the shared resolver (`src/resolver/`) when a
`<router>` target cannot be turned into a transport endpoint.

- [`target/mac-unresolved`](./target/mac-unresolved.md)
- [`target/mac-not-in-arp`](./target/mac-not-in-arp.md)
