# centrs

`centrs` is the tikoci RouterOS interaction hub: a Bun/TypeScript library and future CLI, TUI, HTTP proxy/daemon, and MCP server for talking to MikroTik RouterOS devices through a regularized interface.

> **Status:** pre-alpha / design-first. Core RouterOS transports, CLI commands, proxy, and MCP surfaces are not implemented yet; this repository currently defines the contract, workflow, and scaffolding for current development.

The project is intentionally a **friendly conduit**, not a high-level configuration abstraction. It should help humans and agents reach RouterOS over the right protocol, with the right credentials and ports, and validate RouterOS-shaped commands before writes when possible. It should not hide RouterOS behind helpers like `createVlanOnBridge()`.

## Product direction

- **Frontends:** TypeScript API first, then CLI, TUI, MCP tools, and an HTTP proxy/daemon.
- **Access protocols:** REST API, native API, SSH, SNMP, MNDP, MAC Telnet, RoMON, WinBox Terminal, and file transfer paths where they are the correct fit.
- **Device sources:** explicit CLI/API input, environment variables, SQLite cache, WinBox CDB, The Dude `dude.db`, and MNDP discovery.
- **Validation:** default to explain/validate/run flows for write-shaped operations using RouterOS schema and `/console/inspect` knowledge from related tikoci projects.
- **Agent UX:** typed exports, JSDoc, generated docs, stable CLI help, and actionable error messages that tell the caller what to fix next.

## Planned CLI shape

The CLI is not implemented yet; this is the current contract the rest of the project should grow toward.

| Command | Purpose |
| --- | --- |
| `centrs execute <device-or-group> -- <routeros-command>` | Run RouterOS CLI/script through a selected protocol, validating by default before write-shaped operations. |
| `centrs terminal <device-or-group>` | Open an interactive terminal through SSH, WinBox Terminal, MAC Telnet, RoMON, or another supported path. |
| `centrs retrieve <device-or-group> <path-or-oid>` | Read RouterOS values through REST/native API or SNMP without inventing extra RouterOS semantics. |
| `centrs update <device-or-group> <path> ...` | Apply RouterOS updates with validation and explicit protocol selection. |
| `centrs check <device-or-address>` | Run reachability and management-port checks, enriched with MNDP and RouterOS service hints. |
| `centrs upload/download ...` | Move files using REST for small files and SCP/SFTP or RouterOS `/tool/fetch` where appropriate. |
| `centrs devices` | Show discovered, cached, and configured RouterOS devices and groups. |
| `centrs proxy <device>` | Start the HTTP/WebSocket proxy surface for RouterOS REST/native API access. |

## Settings model

Every frontend should use the same settings vocabulary and precedence:

1. Explicit API/MCP parameters or CLI flags.
2. Environment variables and Bun-loaded `.env` / `.env.<NODE_ENV>` files.
3. Project/user settings and SQLite cache.
4. Imported device databases such as WinBox CDB and The Dude `dude.db`.
5. Passive discovery such as MNDP, treated as hints rather than proof that a device exists or does not exist.

## Development

Requirements:

- Bun 1.3 or newer.
- Git.
- Optional integration-test tools: QEMU/KVM on Linux runners or local QEMU, plus `@tikoci/quickchr`.
- Optional protocol tools for manual testing: SSH, `tmux`, and platform networking utilities.

Common commands:

```bash
bun install
bun run lint
bun run test
bun run build
```

Generated API docs are planned through TypeDoc:

```bash
bun run build:doc:api
```

## Current alpha direction

The recommended first alpha is **protocol-grounding first, then CLI-only,
macOS-local, explicit target input, explicit `via`, and one real transport path
before broadening**. REST is the current preferred first implementation, but it
should follow a grounded protocol matrix covering capabilities, settings,
validation sources, local dependencies, security warnings, and CHR testability
for the full planned protocol set.

Useful decisions to make before implementing the first command:

- What facts must be captured in the protocol matrix before transport code
  starts?
- Which transport lands first: REST, SSH, or native API?
- Should alpha credentials be environment-only, macOS Keychain-backed, or both?
- Which validation source lands first: static schema, live `/console/inspect`, or both?
- Which device sources are in alpha: explicit input/env only, SQLite cache, WinBox CDB, or Dude DB?

## Project workflow

Start with these files when changing direction or adding a feature:

- `AGENTS.md` for repository-level agent workflow.
- `docs/WORKFLOW.md` for `/work` to `docs/specs` promotion.
- `docs/ARCHITECTURE.md` for system boundaries.
- `docs/specs/` for stable requirements.
- `work/20260430A-initial-design/GOAL.md` for the original human-authored grounding prompt behind the current baseline.
