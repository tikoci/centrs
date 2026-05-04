# Goal: name resolution and discovery policy

## Problem

`centrs` talks about targets as `<IP/DNS/"name">`, but the policy behind
resolving `"name"` is still under-specified. Explicit values and WinBox CDB
lookup are reasonably clear for alpha, but MNDP-backed names, waiting behavior,
cache expiry, and the boundary between "helpful first lookup" and
"authoritative inventory" are not.

This work item stages that logic before commands such as `centrs check`,
discovery-assisted targeting, or long-lived caches rely on an implicit policy.

## Scope

- Define the resolution order across explicit values, DNS, WinBox CDB aliases,
  SQLite cache, and MNDP hints.
- Decide when the CLI may wait for discovery and when it must fail fast.
- Define expiry and freshness rules for discovery-backed names.
- Separate read-only name enrichment from broader discovery/import behavior.
- Feed stable outcomes back into `S003`, `S004`, and future command specs.

## Non-goals

- Implement MNDP discovery.
- Finalize the native SQLite schema.
- Turn passive discovery into authoritative inventory.

## Source material

- `docs/specs/S003-device-discovery-and-cache.md`
- `docs/specs/S004-cli-settings-and-precedence.md`
- `work/20260430B-protocol-data-grounding/`
- `work/20260504A-typed-core-seams/`
