# S007: Structured Errors and Bug Reports

## Status

Draft.

Metadata:

- Supersedes: none
- Superseded by: none
- Scope: extends S004, S006
- Review source: `work/20260504A-typed-core-seams/`

## Context

`centrs` already treats actionable diagnostics as part of the product direction,
but there is no shared error type, stable error-code vocabulary, or redaction
policy in code or specs. Without that shared contract, each future transport and
frontend will invent its own error shapes, making CLI UX inconsistent and bug
reports hard to compare.

This spec stages the shared error and bug-report contract before transport work
widens.

## Requirements

- All frontends and the TypeScript API should share one structured error type,
  tentatively `CentrsError`.
- The structured error should carry a stable machine-readable `code`, a human
  summary, remediation guidance, and optional typed context such as:
  - requested capability,
  - requested protocol,
  - target input and resolved host/port when safe to include,
  - relevant setting names and winning sources,
  - RouterOS path or capability details when available,
  - structured cause data instead of flattened string-only nesting.
- The same error instance should be rendered as:
  - concise human CLI output,
  - machine-readable JSON,
  - MCP/tool-facing structured data,
  - a redacted bug-report envelope.
- Stable codes should exist before multiple transports ship. Exact names may
  change during this Draft, but the families should cover:
  - input and validation failures,
  - settings-resolution failures,
  - target-resolution failures,
  - network and transport failures,
  - authentication and authorization failures,
  - RouterOS capability/version/path failures,
  - missing local tool or platform prerequisite failures,
  - internal invariant failures.
- Error output must be actionable. When a protocol, host, port, or missing
  dependency is known, the rendered output should name it and point at the next
  corrective action.
- Bug-report output must be safe by default. Secrets and imported-source payloads
  must never appear in the report envelope, and sensitive identifiers such as
  usernames, MAC addresses, and local file paths should be redacted unless the
  caller explicitly opts in.

## Canonical failure classes

Every transport should eventually map its failures into the shared families
below instead of inventing transport-specific ad hoc strings.

| Family | Example failures | Required context when known |
| --- | --- | --- |
| `input/*` | invalid CLI shape, invalid RouterOS path, mutually exclusive flags | input field, expected shape |
| `settings/*` | missing `via`, conflicting env/flag values, unusable config source | setting name, winning/blocked source |
| `target/*` | unresolved device, ambiguous device match, stale imported entry | original target text, provenance hints |
| `transport/*` | DNS failure, timeout, refused connection, TLS mismatch | protocol, host, port |
| `auth/*` | rejected credentials, missing auth material, permission denied | protocol, auth mechanism |
| `routeros/*` | unsupported capability, version too old, missing package/path | RouterOS path, version if known |
| `tool/*` | missing SSH client, missing WinBox helper, unsupported platform | tool name, remediation |
| `internal/*` | violated invariant, unclassified adapter bug | stable code, correlation details |

## Bug-report envelope

The bug-report envelope should be a redacted structured document derived from
the same `CentrsError`, not a separate handwritten template. At minimum it
should capture:

- `centrs` version and surface (`api`, `cli`, `mcp`, `tui`, or `proxy`),
- requested capability and protocol,
- redacted target/settings context plus winning-source metadata,
- structured error code, summary, remediation, and cause chain,
- whether the failure came from live RouterOS, local tooling, or preflight
  validation,
- enough reproduction detail to correlate against specs and tests without
  pasting secrets.

## Out of scope for this Draft

- Finalizing the exact TypeScript class/interface shape.
- Finalizing the complete code enum spelling.
- Choosing between a dedicated `bug-report` command and an inline `--bug-report`
  flag.

## Open questions

- Should codes use slash, dot, or another namespace separator?
- Which identifiers should stay visible by default in local CLI output but be
  redacted in bug-report output?
- Should bug-report generation be a dedicated command, an inline flag, or both?
