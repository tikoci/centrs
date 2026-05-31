# centrs

`centrs` is the tikoci RouterOS interaction hub: a Bun/TypeScript library and
CLI (with MCP, TUI, and HTTP proxy frontends planned) for talking to MikroTik
RouterOS devices through a regularized, validated interface.

The project is a **friendly conduit**, not a high-level configuration
abstraction. It helps humans and agents reach RouterOS over the right
protocol, with the right credentials and ports, and validates RouterOS-shaped
commands before execution. It does **not** hide RouterOS behind helpers like
`createVlanOnBridge()`. Without validation and structured diagnostics, this
would be a worse `curl` — those are the product.

## Where things live

- **`docs/CONSTITUTION.md`** — load-bearing rules: validation, result
  envelope, error model, settings precedence, identity/CDB, protocol
  selection, done definition.
- **`docs/MATRIX.md`** — command×protocol grid; the only status surface.
- **`commands/<name>/`** — per-command README and executable examples.
- **`src/`** — Bun/TypeScript source.
- **`test/`** — unit and CHR-backed integration tests.

There is no `docs/specs/`, no `work/`, no roadmap doc. The matrix is the
roadmap.

## Frontends and protocols

- **Frontends:** TypeScript API (root), CLI (in progress), MCP tools, TUI,
  HTTP proxy/daemon (future).
- **Protocols:** REST API (first), native API, SNMP for retrieve,
  SSH/MAC-Telnet/RoMON/WinBox Terminal for execute, plus discover (MNDP).
- **Device sources:** explicit input, environment variables, WinBox CDB
  (`~/.config/tikoci/winbox.cdb`), MNDP cache (planned), and Dude DB import
  (delegated to `tikoci/donny`).

## Commands

Status lives only in `docs/MATRIX.md`.

| Command    | Purpose |
| ---------- | ------- |
| `retrieve` | Read RouterOS state over REST/native API and SNMP OID/MIB values. |
| `execute`  | Run RouterOS CLI-shaped read/write commands (add/set/remove) over native API/REST/L2 surfaces. |
| `terminal` | Open an interactive console, primarily SSH or MAC-Telnet. |
| `check`    | Probe reachability and management protocol availability. |
| `devices`  | View and maintain the CDB-backed device registry. |
| `discover` | Discover MNDP neighbors and optionally save them into CDB. |

Each command's directory under `commands/` carries the design and the
executable example list that gates "done".

## Validation, envelope, errors — quick read

- Default `validate=true`. Validation runs through `/console/inspect` for
  `retrieve`-style reads and `[:parse]` for CLI-shaped `execute`.
- All calls return one envelope: `{ ok, data?, warnings?, error?, meta }`
  with provenance and source-of-truth reporting.
- Errors are typed values with slash-namespaced codes (`routeros/...`,
  `transport/...`, `validation/...`) and a `details_url` pointing to
  `https://tikoci.github.io/centrs/errors/<code>`.

Full contract: `docs/CONSTITUTION.md`.

## Development

Requirements:

- Bun 1.3.11 or newer (CI pinned to 1.3.13; Bun 2.x not yet validated).
- Git.
- For integration tests: QEMU plus `@tikoci/quickchr` (handles CHR image
  download and boot).

```bash
bun install
bun run lint
bun run test
bun run test:integration   # CHR-backed; required before claiming "done" on transport code
bun run test:integration:long-term  # channel-specific CHR gate
bun run build
```

Generated API docs through TypeDoc:

```bash
bun run build:doc:api
```

## Done definition (short version)

A feature is done when every line in `commands/<name>/examples.md` is green
on real CHR via `bun run test:integration`. Code existing is not done. Unit
tests passing is not done. Full rule:
`.github/instructions/done-definition.instructions.md`.
