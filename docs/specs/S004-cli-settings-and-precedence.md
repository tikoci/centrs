---
status: Accepted
supersedes: none
superseded_by: none
scope: baseline
review_source: work/20260430A-initial-design/GOAL.md; work/20260504A-typed-core-seams/
---

# S004: CLI Settings and Precedence

## Context

CLI, API, MCP, TUI, and proxy surfaces must share setting names and behavior. Agents should not need to rediscover different option spellings for each frontend.

## Requirements

- Define settings once in typed code and reuse them in generated docs/help where possible.
- Keep CLI flags, environment variables, API parameters, and MCP tool arguments aligned.
- Prefer explicit values over cached or discovered values.
- Explain the winning source for important resolved settings in verbose/debug output.
- Do not silently fall back from a requested protocol to another protocol.
- Treat protocol-specific limits as first-class setting behavior. If a requested
  value is invalid for the selected protocol, return a typed error instead of
  silently rounding, truncating, or ignoring it.
- Alpha should require explicit `via` until automatic protocol selection has a spec, tests, and user-visible diagnostics.

## Precedence

1. Explicit API/MCP parameters or CLI flags.
2. Environment variables and Bun-loaded `.env` / `.env.<NODE_ENV>` files.
3. Project or user settings.
4. SQLite cache.
5. Imported CDB or Dude database values.
6. Discovery hints such as MNDP.

Project and user settings should live in the platform-appropriate application
config locations; on Unix-like systems that means an XDG-style config path
instead of ad hoc dotfiles.

## Planned common settings

| Setting | Purpose |
| --- | --- |
| `device` / `group` | Target selection. |
| `via` | Requested protocol adapter. |
| `host`, `address`, `mac` | Direct target coordinates. |
| `username`, `password` | Credentials or credential lookup hints. |
| `cdb-file`, `cdb-password` | WinBox CDB lookup path and CDB decryption password, distinct from RouterOS login credentials. |
| `timeout` | Operation timeout, validated against protocol-specific limits such as REST-side ceilings. |
| `validate` | Enable or disable preflight validation. |
| `cache` | Control whether resolved metadata is written back. |
| `format` | Output format such as text, JSON, YAML, or table when the command has a table rendering. |
