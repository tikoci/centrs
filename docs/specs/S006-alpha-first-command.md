---
status: Draft
supersedes: none
superseded_by: none
scope: extends S002, S003, S004
review_source: work/20260430A-initial-design/GOAL.md open follow-ups; README Current alpha direction; work/20260430B-protocol-data-grounding/; work/20260504A-typed-core-seams/; work/20260504B-quickchr-harness/; work/20260504C-name-resolution-and-discovery/
---

# S006: Alpha First Command (REST Retrieve)

## Context

`S002`, `S003`, and `S004` now establish the broad alpha direction: `rest-api`
first, `centrs retrieve` first, explicit/env values first with read-only WinBox
CDB lookup, and no silent protocol fallback. This Draft captures the still-moving
contract details needed before and during the first real implementation.

`work/20260430B-protocol-data-grounding/` remains the evidence collector for
protocol and data-source grounding. `work/20260504A-typed-core-seams/` remains
the staging area for shared contracts that are not yet stable enough to freeze
in Accepted specs.

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

## Alpha implementation slice

The first runnable slice should be intentionally small:

- local CLI and TypeScript API first,
- explicit `via`, with `rest-api` as the only implemented alpha adapter,
- one read-only command: `retrieve`,
- explicit/env values first, with read-only WinBox CDB lookup for named-device
  enrichment when explicit values are missing,
- a shared `timeout` setting whose validation is adapter-aware,
- one structured envelope for success and failure so warnings, provenance, and
  size-limit metadata survive JSON/YAML/API use,
- CHR-backed tests as the proof point for the round-trip.

## Proposed defaults

These are starting positions; resolve before promoting status to `Accepted`.

| Decision | Proposed alpha default | Rationale |
| --- | --- | --- |
| First implementation after grounding | `rest-api` over HTTPS | Best current candidate: well-understood protocol surface, compatible with `restraml` and `quickchr`, and good for read-only retrieve work. Use REST as the initial guinea pig, not as the common denominator for every later adapter. |
| Credentials | Explicit CLI/API values and environment variables first, with read-only WinBox CDB lookup available for name/group/user/password enrichment | Keeps explicit values authoritative while allowing alpha usability to benefit from local saved-router data. The CDB file password is a separate concern from RouterOS login credentials. |
| Validation source | `/console/inspect` for retrieve path/attribute validation; fast parse checks for later CLI-shaped `execute` work | `retrieve` should use inspect-driven syntax and attribute discovery. Future CLI-shaped validation should favor the fastest binary signal first, such as `:put [:parse ...]` exposed through `/rest/parse`. |
| Device sources | Explicit input + environment + read-only WinBox CDB lookup | Defers SQLite, Dude DB, and MNDP-backed discovery policy. Name-resolution behavior beyond explicit values and CDB lookup stays staged until expiry/wait semantics are specified. |
| Required `via` | Always required, never inferred | Per S004; no silent protocol fallback. |
| Timeout | Shared setting with protocol-specific validation | Treat timeout as a first-class setting. For REST, reject values above the effective RouterOS-side ceiling rather than pretending longer timeouts will work. |
| CLI parser | Hand-written argv parsing until at least three real commands exist | Avoids locking in a framework before the alpha command surface and help shape settle. |

## First command contract

After the protocol grounding gate and pre-transport seams are satisfied, the
first runnable CLI/API milestone should be the smallest read-only RouterOS
round-trip:

```text
centrs retrieve <target> <routeros-path> [flags]
```

Alpha contract for `retrieve`:

- The required path argument is a slash-prefixed RouterOS path for alpha.
  Shortcut aliases or non-path positional forms remain future work unless they
  are explicitly specified later.
- The baseline mapping is RouterOS `print`-style reads. Special-case non-`print`
  mappings are out of alpha unless explicitly documented.
- `--attribute <name>` and `--attributes <a,b>` project selected attributes.
- `--all-attributes` asks for the RouterOS detail/all-attributes shape and is
  mutually exclusive with attribute projection.
- `--list-attributes` and `--list` return inspect-derived attribute names
  without running the data call.
- `--filter` and `--query` may be surfaced early only as explicit
  "Not implemented" placeholders; they are not part of the first working loop.
- `--format` must support at least text, JSON, and YAML. `--json` may exist as
  CLI sugar for the JSON envelope output.
- `--max-results <bytes>` sets a serialized output budget. If the budget is
  exceeded, the command returns a structured limit error naming object count and
  required size rather than silently truncating.

## Validation and diagnostics

- `retrieve` should use live `/console/inspect` data to validate path, verb, and
  attribute selection. The current implementation starts with `request=child`
  for print availability and attribute discovery; stricter `request=syntax`
  handling remains part of the hardening path.
- The same inspect data should power `--list-attributes` and suggestion-style
  errors for bad paths or attributes.
- Future CLI-shaped `execute` work is intentionally different: it should use
  fast parse checks such as `/rest/parse` instead of forcing retrieve and
  execute through one fake shared validator.
- CLI/API structured output should share one envelope carrying success/failure,
  warnings, target/protocol metadata, and limit facts.

`centrs check` remains a planned command, but it should not lead the alpha. Its
behavior depends on a better-specified model for name resolution, reachability,
management-path probing, and discovery hints.

Acceptance for the alpha milestone:

- `centrs --help` and `centrs retrieve --help` are generated from typed command
  metadata.
- `CENTRS_*` settings from S004 resolve through the documented precedence, and
  the resolved source is shown in `--verbose` output.
- A `quickchr`-backed integration test boots a CHR, runs
  `centrs retrieve <target> /system/resource --via rest-api --format json`
  against it, and asserts structured data with `version` and `uptime` fields.
- A `quickchr`-backed integration test proves
  `centrs retrieve <target> /ip/address --via rest-api --list-attributes`
  returns inspect-derived attribute names without running the data call.
- A `quickchr`-backed integration test proves
  `centrs retrieve <target> /ip/address --via rest-api --attribute address --format json`
  returns projected structured data.
- Failure-path tests assert that canonical unreachable/auth/unsupported cases
  produce structured actionable errors naming protocol, host, port, code, and
  remediation.
- Failure-path tests also cover inspect validation failures, timeout ceiling
  violations, and oversized result-budget failures.

## Out of alpha

- `update`, `execute`, and `check`.
- Protocol fallback or automatic `via` selection.
- Shortcut aliases or extra positional selector forms beyond the RouterOS path.
- Group fan-out aggregation and multi-target output policy.
- Native API, SSH, SNMP, MNDP, MAC Telnet, RoMON, WinBox Terminal.
- HTTP/WebSocket proxy and MCP frontends.
- Broad WinBox CDB or Dude DB import/persist behavior.
- macOS Keychain or other secret stores.

## Remaining open questions

- Are the current implementation envelope fields (`ok`, `capability`, `via`,
  `target`, `auth`, `request`, `validation`, `result`, `warnings`,
  `settingSources`) stable enough to promote into the Accepted contract?
- Should named groups fan out in the first implementation, or only after
  aggregation semantics are typed?
- What exact default XDG-style WinBox CDB lookup path/name should alpha use?
- Should the alpha CLI stay on hand-written argv parsing until the second or
  third real command lands?
