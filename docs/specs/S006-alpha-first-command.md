# S006: Protocol Grounding and Alpha First Command

## Status

Draft.

Metadata:

- Supersedes: none
- Superseded by: none
- Scope: extends S002, S003, S004
- Review source: `work/20260430A-initial-design/GOAL.md` open follow-ups; README "Current alpha direction"; `work/20260430B-protocol-data-grounding/`.

## Context

`README.md`, `S002`, `S003`, and `S004` describe the full surface but leave
the protocol-grounding work and four alpha decisions open:

1. What each planned protocol can really do, what it needs, and how it fails.
2. Which transport lands first (REST, SSH, or native API).
3. Whether alpha credentials are environment-only, macOS Keychain-backed, or both.
4. Which validation source lands first (static schema, live `/console/inspect`, or both).
5. Which device sources are in alpha (explicit/env only, SQLite cache, WinBox CDB, Dude DB).

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

## Proposed defaults

These are starting positions; resolve before promoting status to `Accepted`.

| Decision | Proposed alpha default | Rationale |
| --- | --- | --- |
| First implementation after grounding | `rest-api` over HTTPS | Best current candidate: clean `/rest` shape, compatible with `restraml` and `quickchr`, and good for read-only `/system/resource`. Grounding found no blocker; REST cannot provide continuous monitor/eventing, but that is outside the first retrieve milestone. |
| Credentials | Environment variables and CLI flags only | Defers Keychain integration until after the first transport works. |
| Validation source | Static schema plus `rosetta`/`restraml` grounding; live `/console/inspect` evaluated before implementation | Keeps the first adapter self-contained while making the validation gap explicit. Live inspect should be adopted early if it can use REST one-shot calls safely for the first command. Native API eventing/listen is important but should not be smuggled into the first read-only REST milestone. |
| Device sources | Explicit input + environment | Defers SQLite, WinBox CDB, Dude DB, MNDP. |
| Required `via` | Always required, never inferred | Per S004; no silent protocol fallback. |

## First command

After the protocol grounding gate is satisfied, the first runnable CLI command
should be the smallest read-only RouterOS round-trip:

```text
centrs retrieve <device> /system/resource --via rest-api --format json
```

Acceptance for the alpha milestone:

- Protocol matrix exists and explains why `rest-api` is the first implemented
  adapter.
- `centrs --help` and `centrs retrieve --help` are generated from typed command metadata.
- `CENTRS_*` settings from S004 resolve through the documented precedence and the
  resolved source is shown in `--verbose` output.
- A `quickchr`-backed integration test boots a CHR, runs the command against it,
  and asserts a non-empty JSON object with `version` and `uptime` fields.
- A failure path test asserts that an unreachable host produces an actionable
  error naming protocol, host, port, and remediation.

## Out of alpha

- Write-shaped operations (`update`, `execute`).
- Native API, SSH, SNMP, MNDP, MAC Telnet, RoMON, WinBox Terminal.
- HTTP/WebSocket proxy and MCP frontends.
- WinBox CDB, Dude DB, MNDP discovery imports.
- macOS Keychain or other secret stores.

## Open questions

- Which matrix rows from `work/20260430B-protocol-data-grounding/` are stable
  enough to promote into this spec, S002, or S003?
- Should `centrs retrieve` accept a RouterOS path (`/system/resource`) and a
  `--print` flag mirroring RouterOS console behavior, or should it have a
  separate `--columns` projection?
- Should the alpha CLI add a framework such as `clipanion`, or stay on a
  hand-written argv parser until the command surface stabilizes?
- Should the first integration test run on macOS via local QEMU, on Linux CI
  via `quickchr`, or both?
