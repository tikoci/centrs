---
status: Accepted
supersedes: none
superseded_by: none
scope: baseline
review_source: work/20260430A-initial-design/GOAL.md; work/20260430B-protocol-data-grounding/; work/20260504A-typed-core-seams/
---

# S002: Protocols and Access

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
- Protocol-specific limits such as router-side timeouts or capability ceilings
  that must not be mistaken for cross-protocol behavior.
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

Alpha should implement one read-only `retrieve` loop via `rest-api` first.
Treat REST as the first guinea pig, not as the shared contract baseline.
Native API remains the strategic next transport for eventing and proxy work, and
SSH remains the likely lead path for terminal and larger file-transfer
workflows. SNMP, MNDP, MAC Telnet, RoMON, WinBox Terminal, proxy, and richer
file-transfer behavior remain planned until the first retrieve loop, shared
timeout behavior, and CHR-backed error handling are proven.

## Validation flow

1. Parse RouterOS input into a canonical shape.
2. Validate path, verb, and arguments against static schema and the fastest
   useful live RouterOS validation source available for the protocol in play.
   For retrieve-style REST work, that starts with
   `/console/inspect request=syntax` plus inspect-driven attribute discovery. For
   future CLI-shaped `execute` work, fast parse checks such as
   `:put [:parse ...]` exposed through `/rest/parse` are the first binary gate.
3. Report all validation findings with the source of the validation data.
4. Re-validate in runner code before touching a router.

## Related projects

- `restraml` owns REST endpoint schema and deep inspect artifacts.
- `lsp-routeros-ts` owns RouterOS language/canonicalization patterns.
- `rosetta` provides RouterOS docs and command-tree retrieval.
- `quickchr` provides CHR-backed integration-test execution.
