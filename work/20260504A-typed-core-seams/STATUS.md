# Status: typed core seams

## Initial inventory

| Surface | Implemented | Status |
| --- | --- | --- |
| `src/data/winbox-cdb.ts` parse/encode/decrypt/encrypt | Yes | Solid grounded slice with substantial tests |
| `src/protocols/index.ts` registry | Metadata only | Planned capability list, not an adapter contract |
| `src/cli.ts` | Help text only | Functional stub, not a real command surface |
| `src/index.ts`, `src/mcp.ts`, `src/tui.ts`, `src/webproxy.ts` | Placeholder exports | Describe surfaces, no runnable behavior |
| `src/data/dude-db.ts`, `src/data/mndp-cache.ts` | Empty files | Not yet staged beyond placeholders |
| `test/integration/rest-retrieve.test.ts` | `describe.skip` placeholder | No CHR harness or transport wiring yet |

## Gaps already tracked elsewhere

1. First REST retrieve command in `S006`.
2. CLI parser choice in `S006`.
3. Static validation versus live `/console/inspect` in `S006`.
4. CDB promotion into device resolution in `work/20260502A-winbox-cdb-device-store/`.
5. Layer-2 lab coverage for MNDP, MAC Telnet, and RoMON in `work/20260502B-routeros-l2-lab/`.
6. WinBox Terminal feasibility in `work/20260502C-winbox-terminal/`.

## Gaps this work item stages

- Shared transport adapter contract instead of metadata-only protocol plans.
- Shared target type plus provenance-aware `resolveTarget(...)`.
- Shared `resolveSettings(...)` behavior for `CENTRS_*` settings and verbose
  winning-source reporting.
- Shared `CentrsError` shape, stable error-code families, and redaction-aware
  bug-report envelope.
- A first-class developer-UX stance: help, diagnostics, and machine-readable
  errors should be considered part of the core contract, not frontend polish.

## Working posture

The goal is not transport breadth. The goal is to keep the next implementation
steps from forcing the same refactor through CLI, API, MCP, TUI, proxy, and
tests. Transport fidelity, test confidence, and developer UX should all shape
the shared seams before multiple adapters land.
