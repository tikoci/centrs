# centrs

`centrs` is the tikoci RouterOS interaction hub: a Bun/TypeScript library and future CLI, TUI, HTTP proxy/daemon, and MCP server for talking to MikroTik RouterOS devices through a regularized interface.

> **Status:** pre-alpha. The first real vertical slice now exists: `centrs retrieve`
> over `rest-api`, plus the shared error/settings/output seams behind it. The rest
> of the CLI, broader transport set, proxy, and MCP surfaces remain staged work.
>
> **Implementation reality:** the WinBox CDB codec remains the deepest grounded
> slice, and `retrieve` is now the first real RouterOS round-trip. The rest of the
> CLI/API/TUI/MCP/proxy surface area is still mostly scaffolding, and The Dude and
> MNDP data sources remain placeholders.

The project is intentionally a **friendly conduit**, not a high-level configuration abstraction. It should help humans and agents reach RouterOS over the right protocol, with the right credentials and ports, and validate RouterOS-shaped commands before writes when possible. It should not hide RouterOS behind helpers like `createVlanOnBridge()`.

## Product direction

- **Frontends:** TypeScript API first, then CLI, TUI, MCP tools, and an HTTP proxy/daemon.
- **Access protocols:** REST API, native API, SSH, SNMP, MNDP, MAC Telnet, RoMON, WinBox Terminal, and file transfer paths where they are the correct fit.
- **Device sources:** explicit CLI/API input, environment variables, SQLite cache, WinBox CDB, The Dude `dude.db`, and MNDP discovery.
- **Validation:** default to explain/validate/run flows for write-shaped operations using RouterOS schema and `/console/inspect` knowledge from related tikoci projects.
- **Agent UX:** typed exports, JSDoc, generated docs, stable CLI help, and actionable error messages that tell the caller what to fix next.

## Current implementation snapshot

This table is intentionally blunt so future work starts from the code that exists,
not from the surface the docs eventually describe. See
`work/20260504A-typed-core-seams/` for the fuller review inventory and staged
follow-up work.

| Surface | Current state | Notes |
| --- | --- | --- |
| WinBox CDB codec | Implemented | Parse/encode/decrypt/encrypt plus substantial fixture-backed tests. |
| Protocol registry | Partially grounded | Shared capability list remains metadata-heavy, but `rest-api` is now wired for the first real retrieve slice. |
| CLI/API surface | Retrieve alpha only | `centrs retrieve` now resolves explicit/env settings, renders typed help, returns structured JSON/YAML envelopes, and emits actionable errors. |
| TUI/MCP/proxy exports | Scaffolding only | These frontends still describe future surfaces rather than implement them. |
| Device sources beyond CDB | Not implemented | `dude-db.ts` and `mndp-cache.ts` are empty placeholders. |
| RouterOS transport integration | REST retrieve only | Read-only REST retrieve works; richer validation, more transports, and broader CHR coverage remain staged. |

## CLI shape

`retrieve` is the first implemented command. The rest of the table remains the
planned command surface the project should grow toward.

| Command | Purpose |
| --- | --- |
| `centrs execute <device-or-group> -- <routeros-command>` | Run RouterOS CLI/script through a selected protocol, validating by default before write-shaped operations. |
| `centrs terminal <device-or-group>` | Open an interactive terminal through SSH, WinBox Terminal, MAC Telnet, RoMON, or another supported path. |
| `centrs retrieve <device-or-group> <path-or-oid>` | Read RouterOS values through REST/native API or SNMP without inventing extra RouterOS semantics. |
| `centrs update <device-or-group> <path> ...` | Apply RouterOS updates with validation and explicit protocol selection. |
| `centrs check <device-or-address>` | Run reachability and management-port checks, enriched with MNDP and RouterOS service hints. |
| `centrs discover` | Run reachability and management-port checks, enriched with MNDP and RouterOS service hints. |
| `centrs upload/download ...` | Move files using REST for small files and SCP/SFTP or RouterOS `/tool/fetch` where appropriate. |
| `centrs devices` | Show discovered, cached, and configured RouterOS devices and groups. |
| `centrs proxy <device>` | Start the HTTP/WebSocket proxy surface for RouterOS REST/native API access. |

### Alpha retrieve currently implemented

```text
centrs retrieve <target> <routeros-path> --via rest-api [flags]
```

Current alpha behavior:

- Supports text, JSON, and YAML output. JSON/YAML return a shared envelope with
  `ok`, `capability`, `via`, `target`, `auth`, `request`, `validation`,
  `result`, `warnings`, and `settingSources`.
- Supports `--attribute`, `--attributes`, `--all-attributes`,
  `--list-attributes`, `--max-results`, `--validate` / `--no-validate`,
  `--timeout`, and `--verbose`.
- Resolves `via`, `username`, `password`, `timeout`, `format`, and
  `max-results` from explicit CLI values first, then `CENTRS_*` environment
  variables.
- Uses live `/console/inspect` child queries for print availability and
  attribute discovery in the current implementation.
- Returns actionable structured errors for missing `via`, invalid paths,
  oversize output budgets, and common REST transport/auth failures.

Still intentionally out of scope for this first slice:

- automatic protocol selection or fallback,
- multi-target/group fan-out,
- WinBox CDB-backed name enrichment,
- non-REST adapters,
- HTTPS trust-policy knobs beyond Bun's default certificate validation.

## Settings model

Every frontend should use the same settings vocabulary and precedence:

1. Explicit API/MCP parameters or CLI flags.
2. Environment variables and Bun-loaded `.env` / `.env.<NODE_ENV>` files.
3. Project/user settings and SQLite cache.
4. Imported device databases such as WinBox CDB and The Dude `dude.db`.
5. Passive discovery such as MNDP, treated as hints rather than proof that a device exists or does not exist.

## Development

Requirements:

- Bun 1.3.11 or newer. CI and `packageManager` are pinned to Bun 1.3.13; Bun 2.x is not validated here yet.
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

The near-term path is intentionally narrow:

1. land the typed core seams for transport, target resolution, settings
   resolution, shared result/error envelopes, and actionable diagnostics,
2. land the CHR-backed harness tiers and version policy,
3. implement one real `retrieve` loop over REST and use it to settle the shared
   CLI/API shape,
4. only then broaden transports and frontends.

The goal is to avoid attractive stubs that later force the same refactor
through CLI, API, MCP, TUI, proxy, and tests. Transport fidelity, test
confidence, and developer UX are co-equal constraints.

Current working decisions:

- **First transport:** `rest-api` is the first real adapter, but only as the
  initial guinea pig. Native API remains the strategic eventing/proxy transport,
  and SSH is still expected to lead terminal and larger file-transfer work.
- **First command:** `centrs retrieve` stays ahead of `centrs check` and
  `execute`.
- **Target and credential resolution:** explicit CLI/API values and environment
  variables stay authoritative. Read-only WinBox CDB lookup can enrich named
  devices and saved credentials in alpha when explicit values are missing.
- **Validation split:** `retrieve` should use live `/console/inspect` for path
  and attribute validation; future CLI-shaped `execute` work should use fast
  parse checks such as `/rest/parse`.
- **Shared settings and output:** `timeout` is a first-class setting with
  protocol-specific validation, and the first command should return one
  structured envelope across CLI/API JSON/YAML output so success can carry
  warnings, provenance, and size-limit metadata.

See `docs/specs/S006-alpha-first-command.md` for the draft first-command
contract. The exploratory nuance stays in
`work/20260430B-protocol-data-grounding/` and
`work/20260504A-typed-core-seams/`.

## Project workflow

Start with these files when changing direction or adding a feature:

- `AGENTS.md` for repository-level agent workflow.
- `docs/WORKFLOW.md` for `/work` to `docs/specs` promotion.
- `docs/ARCHITECTURE.md` for system boundaries.
- `docs/specs/` for stable requirements.
- `work/20260430A-initial-design/GOAL.md` for the original human-authored grounding prompt behind the current baseline.
