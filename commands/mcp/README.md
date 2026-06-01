# mcp

The MCP frontend: an [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes the centrs core to AI agents through a **small, scoped set of
verbs** over the same canonicalize → validate → run path the CLI/API use. It is
not a per-command tool firehose.

Status: `CHR-passed` (Phase 1 + first Phase 2 CDB mutation). The stdio server
(`src/mcp/server.ts`, `tools.ts`, `safety.ts`, `resources.ts`, `config.ts`) is
built and the examples below (1–10) run green against CHR 7.23 via
`test/integration/mcp.test.ts`, including the gated `mcp=rw` + `confirm:true`
RouterOS write and in-band CDB registration through `centrs_devices add`.
`src/mcp.ts` is the runtime barrel (`@tikoci/centrs/mcp`); `docs/MATRIX.md` is
the authoritative status.

Run it:

```bash
bunx @tikoci/centrs mcp           # stdio transport (default)
centrs mcp                        # same, when installed
centrs mcp start                  # explicit verb; equivalent to the above
```

Bun is required (centrs uses Bun APIs and the bun-native CDB codec), as with
`@tikoci/rosetta`.

## Client install snippets

For an MCP client that accepts JSON server config, use `bunx` directly:

```json
{
  "mcpServers": {
    "centrs": {
      "command": "bunx",
      "args": ["@tikoci/centrs", "mcp"],
      "env": {
        "CENTRS_CDB_FILE": "/absolute/path/to/winbox.cdb"
      }
    }
  }
}
```

If `centrs` is already installed on `PATH`, the equivalent command is:

```json
{
  "mcpServers": {
    "centrs": {
      "command": "centrs",
      "args": ["mcp"],
      "env": {
        "CENTRS_CDB_FILE": "/absolute/path/to/winbox.cdb"
      }
    }
  }
}
```

Use `CENTRS_CDB_PASSWORD` only when reading an encrypted CDB. Encrypted CDB reads
work; encrypted CDB writes remain blocked until the WinBox round-trip is
verified. Prefer an unencrypted throwaway CDB for bench harnesses and CI.

## Why a scoped surface (grounding)

`~/GitHub/bench-routeros-tools` (`REPORT.md`, `docs/REPORT_LIVE_CHR.md`)
benchmarked RouterOS agent support. Load-bearing findings that shape this design:

- **Never expose one tool per RouterOS command.** A 166-tool execution MCP costs
  ~28K always-on tokens and, even free, is ambiguous to select (36/166 tools
  match a task; the correct tool is a clear top-3 pick only 62% of the time;
  destructive tools sit lexically next to safe ones). The recommendation is a
  *handful of verbs* over a canonical `{path, verb, args}`, gated by validation.
- **explain → validate → run split.** A cheap, safe knowledge/validation tier
  gates a thin runner. centrs already has this shape internally.
- **The parse scheme catches parser-level truth that schema-inspect can miss.** In
  the bench, `/console/inspect` accepted a command form the real console parser
  rejected. RouterOS 7.23 no longer reproduces that exact `blackhole=yes` case,
  but the lesson stands: schema-presence is not parser-acceptance.
  `:put [:parse "<cmd>"]` runs the real parser, and centrs runs **both** `:parse`
  and `/console/inspect`, so the MCP exposes validation as a first-class
  **dry-run** tool (`centrs_validate`) that never mutates.
- **Stateful intents need device-validate-before-apply.** Gold using
  `interface=ether2` fails on a CHR exposing only `ether1`. Pair `execute` with
  cheap readback (`retrieve`).

## Intent

- One MCP tool per centrs **verb**, not per RouterOS command. Each tool is a thin
  adapter over the existing core function and returns the standard envelope
  (`{ ok, data?, warnings?, error?, meta }`) as JSON text content — the same
  shape the CLI renders (constitution: result envelope; invariant: one settings
  vocabulary across API/CLI/MCP/TUI/proxy).
- Validation is the product here too: `validate=true` by default, lead with
  `:parse`, never disable to make a call pass (constitution: validation).
- The MCP server is an adapter over the root TypeScript API; it adds no new
  RouterOS semantics, only the MCP transport, the tool schemas, and the
  CDB-backed safety boundary below.

## Tools

| Tool | Core mapping | Reads/Writes | Target source |
| ---- | ------------ | ------------ | ------------- |
| `centrs_explain` | `canonicalizeExecuteCommand` | offline, none | none (string only) |
| `centrs_validate` | execute validation only (`:parse` + `/console/inspect`), **no run** | read-only | CDB |
| `centrs_retrieve` | `retrieve` / `retrieveGroup` | read-only | CDB |
| `centrs_execute` | `execute` | read or write | CDB |
| `centrs_devices` | `devices` (`list`/`show`/`groups`/`add`/`edit`/`set`/`remove`) | CDB read/write | CDB file |
| `centrs_discover` | `discover` (`listen` + optional `save`) | local read; `save` writes CDB | n/a |

- `centrs_explain` is the only tool that needs no CDB and no device — it
  canonicalizes a CLI string to `{ path, verb, args, mode, writeShaped }` so an
  agent can plan before touching anything. centrs owns the script-vs-structured
  gate (constitution: canonicalizer ownership); the MCP must not widen what
  counts as `structured`.
- `centrs_validate` is the headline distilled from the bench: a dry-run that runs
  the real parser plus schema inspection against a registered target and returns
  the validation envelope **without executing**. Use it to reject schema-invalid
  commands before any write.
- `centrs_retrieve` mirrors `retrieve`, including attribute projection,
  `listAttributes`, and `group` fanout.
- `centrs_execute` mirrors `execute`. Read-shaped commands run subject only to
  CDB membership; write-shaped add/set/remove are gated by the CDB policy below.
  Its MCP `destructiveHint` is **conservative — always `true`**, even though the
  tool also serves read-shaped commands: a single execute tool cannot vary the
  static annotation by argument, so it advertises the worst case and lets the
  canonicalizer's write-shape check + the CDB `mcp=rw`/`confirm` gates do the real
  enforcement. Agents that route purely on read-only commands should prefer
  `centrs_retrieve` (truly `readOnlyHint`).
- `centrs_devices` is the in-band way to inspect and grow the allowlist:
  `list`/`show`/`groups` are read-only; `add`/`edit`/`set`/`remove` mutate the
  active CDB and require `confirm: true`. MCP device envelopes redact saved
  passwords and expose only `passwordSet`.
- `centrs_discover` mirrors `discover`: it listens for MNDP neighbors, returns
  the standard discovery envelope, and can persist found neighbors into the
  active CDB with `save: true` + `confirm: true`. Saved records use the same
  provenance/group behavior as the CLI and no RouterOS credentials are returned.

## Safety model — the CDB is the allowlist

The authorization boundary is the WinBox CDB (constitution: identity and CDB),
which is already centrs's device registry **and** native credential store. The
MCP server applies it as a hard allowlist:

- **Targets resolve through the CDB only** — by name, MAC, or `group`. Inline
  ad-hoc `host` + `username` + `password` are **rejected by default** with
  `cdb/target-not-registered`, whose `fix` points at `centrs_devices add`. An
  agent therefore cannot reach an arbitrary router with arbitrary credentials.
- **CDB source** follows the constitution: default
  `~/.config/tikoci/winbox.cdb`, overridden by `CENTRS_CDB_FILE` / `--cdb-file`,
  or a freshly created CDB the operator hands the server at start. With no CDB,
  the server still serves `centrs_explain` (offline); CDB mutations require a
  loadable CDB file.
- **Credentials live in the CDB and are never returned by MCP.** `centrs_devices
  add`/`edit` may write credentials into the active CDB, but tool results and
  resources redact saved passwords and expose only `passwordSet`.
- **Per-device RouterOS read/write policy lives in the CDB.** A device is
  writable only when its record opts in via the comment-kv key `mcp=rw` (default
  `ro`). Reads are allowed for any registered device. Write-shaped
  `centrs_execute` calls require the resolved target to be `mcp=rw`; `mcp` joins
  the comment-kv allowlist (`src/resolver/comment-kv.ts`) and, per the
  constitution, must round-trip through env/CLI/API as well as CDB.
- **Per-call `confirm: true`** stays as a belt-and-suspenders for write-shaped
  calls (the non-TTY analogue of the CLI's `--yes`). A RouterOS write attempt
  against an `mcp=ro` target fails with typed `cdb/write-not-permitted`
  regardless of `confirm`; a local CDB mutation through `centrs_devices` or
  `centrs_discover` `save` fails with `usage/confirmation-required` unless
  explicitly confirmed.
- **`--allow-adhoc-targets`** (off by default) is reserved for one-off lab/power
  user flows. Current RouterOS-facing tools expose no inline host+credential
  schema, so the CDB allowlist remains the only active target source.

This makes the safety story declarative and auditable: *what the agent may touch*
and *whether it may write* are both data in a file the operator controls, not
flags buried in a prompt.

## Resources

The server publishes two read-only MCP **resources** and points its
`instructions` at them so a client discovers them without guessing:

- `centrs://devices` — the known devices in the active CDB (the allowlist
  itself): target, group, user, record type, and the resolved `mcp` write policy
  per record. No passwords. This is how an agent learns what it may act on.
- `centrs://errors` — the centrs error-code catalog: each known `family/code`
  with its stable details URL (`https://tikoci.github.io/centrs/errors/<code>`),
  including the MCP-specific `cdb/target-not-registered` and
  `cdb/write-not-permitted`. Lets an agent resolve an envelope error without a
  round-trip.

## Transports

- **stdio is the only MCP transport.** It matches the common local MCP client
  model and keeps the agent boundary on the operator's machine.
- **HTTP is the proxy surface's job, not the MCP server's.** Remote/HTTP access
  to CDB-gated RouterOS lives in `src/webproxy.ts` (the `centrs-proxy` surface),
  which fronts the same CDB. The MCP server deliberately grows no HTTP/TLS
  listener of its own, so there is one place that owns network exposure.

## Future work

- **Manifest dump for benchmarking (`centrs mcp --list-tools`).** A device-free
  command that prints the registered tool + resource schemas and the server
  `instructions` as JSON, so a harness can measure centrs's always-on context
  cost the same way `bench-routeros-tools` counts mikrotik-mcp's 166 schemas —
  without booting a CHR. Pairs with the stable example IDs already mapped in
  `examples.md` (example N ↔ one assertion in `test/integration/mcp.test.ts`) so
  the bench can cite per-trap results. Requested by the bench review
  (`~/GitHub/bench-routeros-tools/docs/AGENTIC_FUTURES.md` → "benchmark centrs as
  the realized scoped-execution tier").
- **`__default__` fallback-credentials CDB record.** A reserved CDB record
  (working name `__default__`) supplies default metadata + username/password for
  a resolved device that has none set. Precedence: per-call args → ENV
  (`CENTRS_*`) → the matched device record → the `__default__` record → built-in
  default. The sentinel name and any per-field opt-outs ride the comment kv-soup.
  Lands with packaging (Phase 4); the goal is "register a host with no creds and
  still reach it through a shared default."
- **MikroTik docs enrichment.** `centrs_explain` may later annotate a canonical
  `{path, verb}` with a link into MikroTik's new Docusaurus manual at
  <https://manual.mikrotik.com> (CLI/API reference, still WIP upstream). This is
  an independent, optional reference — centrs does not depend on rosetta or any
  other MCP for its canonicalization.

## Open shape questions

These are resolved for the current design and recorded here for provenance:

- **HTTP transport** → owned by the proxy surface, not MCP (resolved).
- **Doc context** → centrs logic only; `manual.mikrotik.com` is a future,
  optional enrichment source (resolved).
- **Resources vs tools** → ship both `centrs://devices` and `centrs://errors` as
  resources, advertised via server instructions (resolved).

These refinements sit on top of the grounded surface above; none blocks the
Phase 1 stdio read/validate cells.

## CHR test shape

Per the done definition, MCP cells advance only with CHR evidence. The
integration test (`test/integration/mcp.test.ts`) boots a CHR via
`@tikoci/quickchr`, registers it in a throwaway CDB to exercise the allowlist
boundary, starts the server, and drives it with an in-process MCP client over
stdio. It asserts, at minimum:

- an unregistered target is rejected (`cdb/target-not-registered`);
- `centrs_validate` accepts parser-valid command text and rejects
  schema-invalid attributes without executing;
- `centrs_retrieve` returns structured records;
- `centrs_execute` (read-shaped) runs and returns the envelope;
- a write against an `mcp=ro` target is refused (`cdb/write-not-permitted`) and
  the same write against an `mcp=rw` target succeeds with `confirm: true`;
- `centrs_devices add` writes a new record into the throwaway CDB and returns no
  saved password material.

Each example in `commands/mcp/examples.md` maps to one such assertion.
