---
status: Draft
supersedes: none
superseded_by: none
scope: extends S002, S003, S004
review_source: work/20260430A-initial-design/GOAL.md open follow-ups; README Current alpha direction; work/20260430B-protocol-data-grounding/; work/20260504A-typed-core-seams/; work/20260504B-quickchr-harness/; work/20260504C-name-resolution-and-discovery/
---

# S006: Protocol Grounding and Alpha First Command

## Context

`README.md`, `S002`, `S003`, and `S004` describe the full surface but leave
the protocol-grounding work and several alpha decisions open:

1. What each planned protocol can really do, what it needs, and how it fails.
2. Which transport lands first (REST, SSH, or native API).
3. How alpha credentials and CDB-backed credential lookup interact.
4. Which validation source lands first for CLI-shaped RouterOS commands.
5. Which device sources and name-resolution behaviors are in alpha.
6. Which shared typed seams must land before transports and frontends branch out.
7. How REST-specific limits such as its execution timeout should surface without
   shaping every later adapter.

Until these are resolved, contributors and agents cannot start the first
runnable RouterOS round-trip without re-litigating scope or coding against
incorrect protocol assumptions. The intended sequence is grounding work first,
spec promotion second, source and integration tests third.

## Protocol grounding gate

Do not start transport implementation until the planned protocol set has a
grounded matrix covering:

- RouterOS service, command path, API endpoint, port, and package/version
  requirements.
- Capabilities: retrieve, update, execute, transfer, terminal, discover, and
  proxy.
- Credential and secret shape, including whether the protocol can safely use
  environment variables only in alpha.
- Local dependencies and platform constraints.
- Validation path: static schema, `rosetta` command tree/docs, `restraml`
  deep-inspect data, live `/console/inspect`, or not applicable.
- CHR/`quickchr` testability.
- Security warnings and failure modes that must become actionable errors.

Use `rosetta` MCP tools before web search for RouterOS paths, properties,
versions, changelogs, and documentation. Use cross-project references from
`restraml`, `lsp-routeros-ts`, `quickchr`, `vscode-tikbook`, and `tiktui` when
they own a protocol detail. The goal is not to implement every protocol first;
the goal is to know the map well enough that CLI settings, environment
variables, validation choices, and error messages will not have to be renamed
after the first adapter lands.

The grounding matrix starts in `work/20260430B-protocol-data-grounding/`, not in
this Draft spec. Keep raw references, dark holes, lab notes, and provisional
rows there. Promote only stable alpha decisions back into this spec and into
S002/S003 after the evidence is reviewable.

## Data, discovery, and eventing grounding gate

Protocol choices affect device targeting and data imports, so the grounding work
must also cover:

- Native API eventing: `.tag`, `/listen`, monitor commands, `/cancel`, `!trap`,
  `!fatal`, orphan replies, recovery, and the known cross-project concern that
  bulk multiplexed API work can destabilize the RouterOS API process.
- MAC-first access: MNDP hints, MAC Telnet emergency terminal access, and how a
  target can carry both IP and MAC identity without treating passive discovery
  as authoritative.
- Local data imports: WinBox CDB, Dude DB, SQLite cache, and credential storage
  boundaries.

These areas remain out of the first alpha implementation unless the grounding
work changes the alpha decision. They still need early evidence so shared
settings, target models, security warnings, and error types stay compatible with
future adapters.

Current grounding supports keeping these areas out of the first alpha:

- Native API is the strategic RouterOS eventing transport, but SSE/WebSocket
  should be modeled as a presentation/proxy layer over native API streams rather
  than as REST eventing.
- MNDP observations are useful target hints and diagnostics, but one physical
  router may appear once per interface and absence from a short scan is not proof
  that a device is offline.
- MAC Telnet and RoMON require L2-capable lab coverage that ordinary QEMU SLiRP
  host forwarding cannot provide.
- WinBox CDB and Dude DB imports can be secret-bearing, so alpha should not
  import or persist them before redaction, fixture, and explicit-import behavior
  are specified.

## Pre-transport seams

Do not implement more than one real transport or any non-trivial frontend until
the following shared seams are typed and reviewed:

- structured `CentrsError` values with stable codes, remediation, and redaction
  rules,
- a transport adapter contract covering capability-specific operations and
  result/error shapes,
- a provenance-aware target model plus `resolveTarget(...)`,
- a settings resolver that reports the winning source for important values,
- the CHR-backed harness tiers and version policy used to validate those seams.

`S007` and `S008` stage the error-contract and harness-policy parts of this
gate. The transport, target, settings, and command-shape details stay staged in
`work/20260504A-typed-core-seams/` until they are grounded enough for promotion.

Developer UX is part of this gate. Generated help, verbose source reporting, and
structured actionable errors should reuse the same typed seams instead of being
bolted on after the first adapter lands.

## Proposed defaults

These are starting positions; resolve before promoting status to `Accepted`.

| Decision | Proposed alpha default | Rationale |
| --- | --- | --- |
| First implementation after grounding | `rest-api` over HTTPS | Best current candidate: well-understood protocol surface, compatible with `restraml` and `quickchr`, and good for read-only `/system/resource`. Use REST as the initial guinea pig, not as the common denominator for every later adapter; capture REST-specific behavior such as `/rest/execute` response quirks and router-side timeout ceilings explicitly. |
| Credentials | Explicit CLI/API values and environment variables first, with WinBox CDB lookup available for name/user/password enrichment | Keeps explicit values authoritative while allowing alpha usability to benefit from read-only CDB resolution. The CDB file password is a separate concern from RouterOS login credentials. |
| Validation source | Fast live parse checks for CLI-shaped commands, with static schema and deeper inspect grounding as complements | For RouterOS CLI-shaped validation, favor the fastest binary signal first, such as `:put [:parse ...]` exposed through `/rest/parse`, before widening to deeper `/console/inspect` integration. The first `retrieve` milestone remains read-only. |
| Device sources | Explicit input + environment + read-only WinBox CDB lookup | Defers SQLite, Dude DB, and MNDP-backed discovery policy. Name-resolution behavior beyond explicit values and CDB lookup stays staged until expiry/wait semantics are specified. |
| Required `via` | Always required, never inferred | Per S004; no silent protocol fallback. |
| Timeout | Shared setting with protocol-specific validation | Treat timeout as a first-class setting. For REST, reject values above the effective RouterOS-side ceiling rather than pretending longer timeouts will work. |
| CLI parser | Hand-written argv parsing until at least three real commands exist | Avoids locking in a framework before the alpha command surface and help shape settle. |

## First command

After the protocol grounding gate and pre-transport seams are satisfied, the
first runnable CLI/API milestone should be the smallest read-only RouterOS
round-trip:

```text
centrs retrieve <device> /system/resource --via rest-api --format json
```

`centrs check` remains a planned command, but it should not lead the alpha.
Its behavior depends on a better-specified model for name resolution,
reachability, management-path probing, and discovery hints.

Acceptance for the alpha milestone:

- Protocol matrix exists and explains why `rest-api` is the first implemented
  adapter.
- `centrs --help` and `centrs retrieve --help` are generated from typed command
  metadata.
- `CENTRS_*` settings from S004 resolve through the documented precedence and the
  resolved source is shown in `--verbose` output.
- A `quickchr`-backed integration test boots a CHR, runs the command against it,
  and asserts a non-empty JSON object with `version` and `uptime` fields.
- Failure-path tests assert that canonical unreachable/auth/unsupported cases
  produce structured actionable errors naming protocol, host, port, code, and
  remediation.

## Out of alpha

- Write-shaped operations (`update`, `execute`).
- Native API, SSH, SNMP, MNDP, MAC Telnet, RoMON, WinBox Terminal.
- HTTP/WebSocket proxy and MCP frontends.
- WinBox CDB, Dude DB, MNDP discovery imports.
- macOS Keychain or other secret stores.

## Open questions

- Which matrix rows from `work/20260430B-protocol-data-grounding/` are stable
  enough to promote into this spec, S002, or S003?
- Which name-resolution and discovery rows need to move from `work/` into S003
  before `centrs check` can be specified cleanly?
- Should `centrs retrieve` accept a RouterOS path (`/system/resource`) and a
  `--print` flag mirroring RouterOS console behavior, or should it have a
  separate `--columns` projection?
- Should the alpha CLI add a framework such as `clipanion`, or stay on a
  hand-written argv parser until the command surface stabilizes?
- Should the first integration test run on macOS via local QEMU, on Linux CI
  via `quickchr`, or both?
- What exact REST parse flow and timeout semantics should become the first typed
  validation and error-contract cases?
