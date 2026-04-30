# S004: CLI Settings and Precedence

## Status

Initial baseline.

## Context

CLI, API, MCP, TUI, and proxy surfaces must share setting names and behavior. Agents should not need to rediscover different option spellings for each frontend.

## Requirements

- Define settings once in typed code and reuse them in generated docs/help where possible.
- Keep CLI flags, environment variables, API parameters, and MCP tool arguments aligned.
- Prefer explicit values over cached or discovered values.
- Explain the winning source for important resolved settings in verbose/debug output.
- Do not silently fall back from a requested protocol to another protocol.

## Precedence

1. Explicit API/MCP parameters or CLI flags.
2. Environment variables and Bun-loaded `.env` / `.env.<NODE_ENV>` files.
3. Project or user settings.
4. SQLite cache.
5. Imported CDB or Dude database values.
6. Discovery hints such as MNDP.

## Planned common settings

| Setting | Purpose |
| --- | --- |
| `device` / `group` | Target selection. |
| `via` | Requested protocol adapter. |
| `host`, `address`, `mac` | Direct target coordinates. |
| `username`, `password` | Credentials or credential lookup hints. |
| `validate` | Enable or disable preflight validation. |
| `cache` | Control whether resolved metadata is written back. |
| `format` | Output format such as text, JSON, or table. |
