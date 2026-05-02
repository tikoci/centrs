# Goal: WinBox Terminal feasibility

## Problem

WinBox Terminal is listed as a planned terminal path, but TCP 8291 reachability is
only a liveness signal. `centrs` should not claim terminal support until a
scriptable protocol, external tool, or clear non-goal decision is grounded.

## Scope

- Inventory terminal-over-WinBox references.
- Decide whether terminal support should be an in-process adapter, an external
  launcher, or a deferred non-goal.
- Identify authentication, CDB, local tooling, and licensing constraints.
- Record which behavior can be tested safely against CHR.

## Non-goals

- Implement WinBox protocol support.
- Depend on proprietary WinBox automation.
- Treat the broader WinBox/Nova research area as an adapter commitment.

## Source material

- `work/20260430B-protocol-data-grounding/protocol-matrix.md`
- `work/20260430B-protocol-data-grounding/layer2-access.md`
- `work/20260430B-protocol-data-grounding/references.md`
- Terminal-over-WinBox and WinBox dissector references listed in 20260430B.
