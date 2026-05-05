---
status: Accepted
supersedes: none
superseded_by: none
scope: baseline
review_source: work/20260430A-initial-design/GOAL.md; work/20260430B-protocol-data-grounding/; work/20260504A-typed-core-seams/
---

# S003: Device Discovery and Cache

## Context

`centrs` should operate on named RouterOS devices and groups without making the user repeat host, port, username, password, and protocol details every time. Device data may come from local files, discovery packets, environment variables, or explicit arguments.

## Requirements

- Merge device data into a traceable registry rather than overwriting source provenance.
- Treat explicit user input as highest precedence.
- Treat MNDP as a hint source, not as proof that an absent device is invalid.
- Store cacheable metadata in SQLite when it improves repeatability.
- Keep credential handling explicit and auditable.
- Support interactive prompts only in interactive frontends; API and automation surfaces must receive typed errors instead.

## Sources

| Source | Use |
| --- | --- |
| CLI/API/MCP parameters | Highest-precedence one-off targeting. |
| Environment variables and `.env` files | Automation-friendly defaults. |
| SQLite cache | Native `centrs` cache for discovered and confirmed metadata. |
| WinBox CDB | Device, group, address, port, username, and password source when readable. |
| The Dude `dude.db` | Alternative device inventory source, grounded by `tikoci/donny`. |
| MNDP | Passive discovery and reachability context. |

## Alpha scope

Alpha should start with explicit input, environment variables, and read-only
WinBox CDB lookup for name, group, address, username, and password enrichment
when the caller did not already provide explicit values. A CDB decryption
password is distinct from RouterOS login credentials. If an explicitly selected
or discovered CDB source cannot be opened, target resolution should fail with a
typed actionable error instead of silently ignoring the source. SQLite cache may
be introduced once the target model is typed. Broad CDB import/persist behavior,
The Dude `dude.db`, and MNDP-backed discovery remain staged until their
provenance, redaction, and expiry behavior are specified.

## Open decisions

- The exact native SQLite schema.
- Whether native storage should use WinBox CDB-compatible structures or an internal schema with import/export.
- Password storage and encryption policy per platform.
- The default XDG-style discovery path/name for read-only WinBox CDB lookup.
- The name-resolution policy across DNS, explicit aliases, WinBox CDB names, and
   MNDP hints.
- Group fan-out semantics for multi-target `retrieve`, `update`, and `execute`.
- Whether first-use name resolution may wait briefly for MNDP before failing, and
   how discovery-backed cache expiry should work when it does.
