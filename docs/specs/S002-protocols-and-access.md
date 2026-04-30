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

## Protocol grounding

Before implementing an adapter, record the grounded facts that affect shared
settings, validation, errors, and tests:

- RouterOS service/API/CLI path, default port, auth model, and version/package
  requirements.
- Supported capabilities and capabilities that are intentionally out of scope.
- Local tooling or platform constraints.
- Validation source and known gaps.
- CHR/`quickchr` test shape.
- Security cautions that must become user-visible warnings or errors.

Use `rosetta` MCP tools for RouterOS documentation, command paths, properties,
versions, and changelogs before falling back to general web search. Use related
tikoci projects for implementation evidence where they own the domain:
`restraml` for REST/schema/inspect data, `lsp-routeros-ts` for
canonicalization and validation, `quickchr` for CHR-backed tests, and
`vscode-tikbook`/`tiktui` for interaction patterns.

## Alpha scope

Alpha should ground the full protocol map first, then implement one real
transport path, with REST currently preferred. Native API, SSH, SNMP, MNDP,
MAC Telnet, RoMON, WinBox Terminal, proxy, and richer file-transfer behavior
remain planned until the first transport loop has validation and CHR-backed
tests.

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
