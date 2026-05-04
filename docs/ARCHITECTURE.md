# Architecture

`centrs` is organized around one core library that normalizes RouterOS access for several frontends. The core owns device resolution, settings precedence, protocol selection, validation hooks, and user-facing diagnostics. CLI, TUI, MCP, and HTTP proxy surfaces should be thin adapters over that core.

## Current implementation reality

The repository already contains one grounded codec-oriented slice: the WinBox CDB
parser/encoder/decryption path plus fixture-backed tests. Most other exported surfaces
are still descriptive scaffolding:

- the protocol registry is a plan list, not a transport contract,
- the CLI renders help but does not dispatch real commands,
- the API/TUI/MCP/proxy exports are placeholders,
- target resolution, settings resolution, and structured cross-surface errors are
  not typed yet,
- RouterOS transport integration and CHR-backed harness wiring remain staged work.

That is acceptable for pre-alpha, but it means future implementation should
optimize for shared seams before transport breadth.

## Boundaries

`centrs` does:

- Resolve RouterOS devices and groups from explicit input, local databases, cache, and discovery.
- Choose and configure access protocols such as REST, native API, SSH, SNMP, MNDP, MAC Telnet, RoMON, and WinBox Terminal.
- Validate RouterOS-shaped commands before write operations when schema or live inspect data is available.
- Provide actionable diagnostics for humans and agents.
- Cache local metadata in SQLite when it improves repeatability and user experience.

`centrs` does not:

- Replace RouterOS syntax with high-level configuration abstractions.
- Treat passive discovery as authoritative inventory.
- Execute write-shaped operations without an explicit target and validation policy.

## Core concepts

### Frontends

The TypeScript API is the root interface. CLI, TUI, MCP, and HTTP proxy surfaces should reuse the same command models, option names, validation, and error types.

### Typed core seams

Before more than one real transport or frontend lands, the core should define
shared typed seams for:

- transport adapters and capability-specific results,
- target identity and provenance-aware `resolveTarget(...)`,
- settings resolution plus winning-source reporting,
- structured `CentrsError` values, redaction, and bug-report envelopes.

Without those seams, each transport will tend to invent its own shapes for
errors, targets, and settings, which would push refactors outward into every
frontend.

### Device registry

The registry is a merged view over:

- explicit host/IP/MAC/credential input,
- environment variables and project settings,
- SQLite cache,
- WinBox CDB,
- The Dude `dude.db`,
- MNDP observations.

Each source should remain traceable so warnings can explain where a device came from and why a field is trusted, missing, or stale.

### Protocol adapters

Protocol adapters handle transport-specific details and expose regularized capabilities: execute, retrieve, update, transfer, discover, terminal, and proxy. Adapters should not rewrite RouterOS semantics beyond serialization, validation, and diagnostics.

### Validation pipeline

Write-shaped calls should follow an explain/validate/run pattern:

1. Parse and canonicalize RouterOS input.
2. Validate against static schema and live `/console/inspect` when available.
3. Return typed, actionable errors when validation fails.
4. Re-validate server-side immediately before execution for any runner that touches a router.

Related tikoci projects provide grounding: `rosetta` for docs/RAG, `restraml` for REST schema and inspect output, `lsp-routeros-ts` for canonicalization and validation patterns, and `quickchr` for CHR-backed integration tests.

### Developer UX

Developer UX is part of the architecture, not polish after transports work.
Stable `--help` output, verbose source reporting, machine-readable errors, and
redacted bug-report envelopes should be treated as shared-core behavior so CLI,
API, MCP, TUI, and proxy users do not each learn a different diagnostic model.

## Invariants

- One settings vocabulary must work across API, CLI, MCP, TUI, and proxy.
- Friendly errors are part of the API contract.
- Typed transport, target, settings, and error contracts must exist before
  multi-transport growth.
- Integration tests should prefer real RouterOS CHR via `quickchr` over elaborate mocks when behavior depends on RouterOS.
- Developer UX is part of correctness; help text, source reporting, and
  bug-reportable errors are not optional polish.
- Generated docs should be preferred when the source of truth is code, CLI metadata, or schema.

## Alpha slice

The first implementation should intentionally be narrower than the full
architecture: local macOS CLI, explicit device/credential input, explicit
protocol selection, one real transport, validation plumbing, and CHR-backed
tests. Before that transport breadth appears, the near-term slice should stage
typed seams, the test harness policy, and a cheap CLI shakedown such as
`centrs check`. Proxy, MCP, CDB/Dude imports, and passive discovery should
remain planned surfaces until the first transport loop is reliable.
