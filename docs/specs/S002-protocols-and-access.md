# S002: Protocols and Access

## Status

Accepted baseline.

Metadata:

- Supersedes: none
- Superseded by: none
- Scope: baseline
- Review source: `work/20260430A-initial-design/GOAL.md`

## Context

RouterOS supports many management paths, and each path has different strengths. `centrs` should make protocol choice explicit and consistent without hiding RouterOS semantics.

## Requirements

- Model protocol adapters around capabilities: execute, retrieve, update, transfer, terminal, discover, and proxy.
- Preserve RouterOS-native paths, arguments, and errors wherever possible.
- Default write-shaped operations to validation before execution when schema or live inspect data is available.
- Allow callers to force a protocol with a shared `via` setting when more than one adapter can satisfy a request.
- Return actionable errors when a protocol is unavailable, unsupported for a capability, or missing local dependencies.

## Initial protocol set

| Protocol | Expected capabilities |
| --- | --- |
| REST API | retrieve, update, execute, small file transfer, proxy. |
| Native API | retrieve, update, execute, proxy where feasible. |
| SSH | execute, terminal, file transfer. |
| SNMP | retrieve. |
| MNDP | discover and enrich diagnostics. |
| MAC Telnet | terminal and emergency access. |
| RoMON | terminal and routed management access. |
| WinBox Terminal | terminal where supported by local tooling. |

## Alpha scope

Alpha should implement one real transport path first, with REST or SSH preferred. Native API, SNMP, MNDP, MAC Telnet, RoMON, WinBox Terminal, proxy, and richer file-transfer behavior remain planned until the first transport loop has validation and CHR-backed tests.

## Validation flow

1. Parse RouterOS CLI/prose into a canonical shape.
2. Validate path, verb, and arguments against static schema and live `/console/inspect` when available.
3. Report all validation findings with the source of the validation data.
4. Re-validate in runner code before touching a router.

## Related projects

- `restraml` owns REST endpoint schema and deep inspect artifacts.
- `lsp-routeros-ts` owns RouterOS language/canonicalization patterns.
- `rosetta` provides RouterOS docs and command-tree retrieval.
- `quickchr` provides CHR-backed integration-test execution.
