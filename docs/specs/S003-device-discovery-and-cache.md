# S003: Device Discovery and Cache

## Status

Initial baseline.

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

## Open decisions

- The exact native SQLite schema.
- Whether native storage should use WinBox CDB-compatible structures or an internal schema with import/export.
- Password storage and encryption policy per platform.
