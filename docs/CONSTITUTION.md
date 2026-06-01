# Constitution

The load-bearing rules for `centrs`. Everything else (per-command READMEs, the
matrix, code, tests) must be consistent with this file. If something here is
wrong, fix it here first, then propagate. If a rule needs an exception, add the
exception here — not in scattered prose.

This file is short on purpose. Resist the urge to grow it.

## What centrs is

A typed library, with CLI/MCP/TUI/proxy frontends, that reaches RouterOS over
multiple protocols and gives the caller **validated** access plus structured,
actionable diagnostics. The TypeScript API is the root surface; everything else
is an adapter over it.

The product is *not* "REST/SSH/native API wrappers." The product is
**validation + structured envelopes + identity resolution** on top of those
transports. Without those, this is a worse `curl`.

## Validation is the product

Every RouterOS-shaped call goes through canonicalize → validate → run →
re-validate-server-side. Validation is not optional polish.

- `retrieve` and other read-shaped calls validate against
  `/console/inspect request=syntax path=...,print` (path joined by commas) and
  attribute inspection. The path syntax (commas, no leading slash, last token
  is the verb) is part of the validator contract.
- `execute` and other CLI-shaped calls validate in two stages. `:put [:parse
  "..."]` is a **syntax** gate only: grounded on CHR 7.23, it rejects malformed
  CLI but accepts unknown attributes and out-of-range values
  (`:put [:parse "/ip/address/add no-such-arg=x"]` returns no error). Semantic
  validation — attribute names and value domains — therefore requires
  `/console/inspect` (as `retrieve` already does) or the server's own
  re-validation on the write round-trip. Parse alone is necessary, not
  sufficient; never treat a clean `:parse` as a passed semantic validation.
- A failing validator is a real result. Surface it with the structured error
  envelope below — do not bypass.

`retrieve` is read-only and structured-data focused; explicit options control
what a single call returns. `execute` is the single read/write surface for
RouterOS add/set/remove and other CLI-shaped commands — there is no separate
`update` command. Generalizing RouterOS add/set into one abstract write verb
needs too many heuristics, so writes ride `execute`'s canonicalize → validate →
run path instead.

**Disabling validation to make a call work is forbidden.** If the validator
rejects something a real router accepts, the validator is wrong; fix the
validator with CHR evidence. If a feature only passes its integration test
with `validate=false`, the feature is not done.

The default is `validate=true`. `--validate=false` exists as an escape hatch
for probing undocumented edges, never as a workaround for a centrs bug.

## Result envelope

Every API/CLI call returns the same shape, regardless of transport:

```ts
{
  ok: boolean,                  // true if the operation succeeded end-to-end
  data?: unknown,               // the payload (array of records, single object, etc.)
  warnings?: Warning[],         // non-fatal anomalies (stale cache, unused --cdb-password, etc.)
  error?: CentrsError,          // present iff ok=false
  meta: {
    target: { ... },            // resolved target + provenance (where each field came from)
    via: RouterOsProtocol,      // chosen protocol id
    settings: { ... },          // settings winners + sources (env / cli / cdb / default)
    validation?: { ... },       // validator name + result, if validation ran
    timing?: { ... },           // request/response durations
    truncated?: { ... },        // populated when --max-results clipped output
  }
}
```

Notes:

- "Success with footnotes" is supported: `ok: true` may carry warnings.
- CLI render must be lossless against the JSON envelope; `--format json` and
  `--format yaml` are aliases that select serialization, not different shapes.
- `data` is the only field that varies by command. The rest is invariant.

## Error model

Errors are typed values, not thrown strings. Every error has:

- `code` — slash-namespaced, RouterOS-style, no spaces. Example:
  `routeros/unsupported-path`, `transport/connection-refused`,
  `validation/unknown-attribute`, `cdb/decrypt-failed`.
- `message` — one human sentence. No stack trace.
- `fix` — one human sentence describing the next step the caller should take.
- `details_url` — pointer to the canonical explanation (see URL scheme).
- `cause?` — structured sub-error, when relevant (RouterOS nova error,
  transport detail). Stack traces and raw exception text are summarized, not
  embedded raw.
- `redactable_fields?` — names of fields the bug-report renderer must redact.

Credentials and private key material are always redactable. Private key paths are
configuration values and may appear in `meta.settings`; redact them only when an
error also carries sensitive key material or a caller explicitly marks the path
as sensitive.

Two error sources must be visually distinguishable:

1. **centrs errors** — bad usage, validator rejection, transport plumbing.
2. **RouterOS errors** — surfaced by the router (HTTP 4xx/5xx, parse refusal,
   nova error). Map to a normalized `routeros/*` code; preserve the original
   string in `cause`.

Mapping RouterOS string errors to normalized codes is ongoing maintenance. The
authoritative vocabulary is the live router's own strings: grounded on CHR 7.23,
the REST `detail` field (HTTP ≥400, shape
`{"detail":"<msg>","error":<http-status>,"message":"<http reason>"}`) and the
native-api `!trap` message carry the **same** text for the same fault, so one
shared table maps both transports. Ground new mappings on CHR evidence, not on
assumption. (`tikoci/m2ir` is referenced for protocol IR but is not an
accessible source for this mapping; the router strings are.)

### Error URL scheme

All errors carry `details_url` of the form:

```text
https://tikoci.github.io/centrs/errors/<code>
```

`<code>` is the slash-namespaced error code as-is. Example:
`https://tikoci.github.io/centrs/errors/routeros/unsupported-path`.

Rules:

- The URL is normalized; the GitHub Pages site routes it to a human page. The
  page is not the typedoc URL — typedoc lives elsewhere.
- Adding an error code requires adding a Pages entry under the same path.
  Code and Pages must ship together; a missing page is a centrs bug.
- The URL must remain stable across centrs versions. If a code is renamed,
  the old URL must redirect.

## Settings precedence

Lowest to highest priority:

1. Built-in defaults
2. Project / config file
3. CDB comment-kv metadata
4. Environment variables (`CENTRS_*`)
5. CLI flags / API call args

`meta.settings` reports the winning source for each resolved setting.

### Identity and CDB

The `<router>` argument may be: an IP, a DNS name, a MAC, or a **name**. A
name is resolved through the CDB (then through ARP / MNDP-derived metadata as
fallbacks once implemented).

CDB resolution:

- Default location: `~/.config/tikoci/winbox.cdb` (XDG Base Directory).
- `--cdb-file` / `CENTRS_CDB_FILE` overrides the location.
- If the CDB is encrypted, `--cdb-password` / `CENTRS_CDB_PASSWORD` (or
  `Bun.secret()` for the CLI, when wired) decrypts.
- Providing `--cdb-password` against an unencrypted CDB is a **warning**, not
  an error; the call still succeeds.
- A name not found in the CDB is an error unless `--username` / `--password`
  were also provided.
- For a MAC target, CDB wins first. If no CDB record matches, `retrieve` may
  opt into local ARP resolution to obtain an IP-level target; `execute`
  defaults to mac-telnet unless the caller explicitly asks to resolve via ARP.
- `discover --save --timeout 60s` writes MNDP-derived targets into CDB with
  provenance metadata and default `group=discovered`; discovery remains a hint
  source, not authoritative inventory.

CDB is the native credential store **and** the device datastore/cache: the
WinBox CDB file at its well-known location holds the inventory directly — there
is no separate SQLite cache. centrs-specific meaning is overlaid via comment-kv
keys and groups. Anything in CDB must also be expressible via env/CLI/API for
tests and ad-hoc use. CDB comments may carry centrs metadata such as `via`,
`port`, and `ssh-key` overrides. `dude.db` import is out of scope here and
belongs to `tikoci/donny`.

Group selectors (e.g. `--group prod-edge`) target CDB groups so a single
`retrieve`/`execute`/etc. fans out to multiple routers. Group output shape
must round-trip through the same envelope.

### MCP surface: the CDB is the allowlist

The MCP frontend (`commands/mcp/`) is an adapter over this core, not a new set of
RouterOS semantics. Its authorization boundary is the CDB:

- RouterOS-facing MCP tools resolve targets through the CDB only (name / MAC /
  group). Inline ad-hoc `host`+`username`+`password` executor arguments are
  rejected by default (`cdb/target-not-registered`); the escape hatch is an
  explicit, off-by-default `--allow-adhoc-targets`. Credentials live in the CDB
  and MCP results/resources must not return saved password material.
- Per-device write policy is CDB data: the comment-kv key `mcp` (`ro` default,
  `rw` to permit writes). Write-shaped RouterOS MCP calls require the resolved
  record to be `mcp=rw`; a per-call `confirm: true` is the non-TTY analogue of
  the CLI's `--yes` but is not sufficient on its own. Local CDB mutations through
  `centrs_devices` and `centrs_discover` `save` require `confirm: true` and
  redacted results. `mcp` is an allowlisted comment-kv key and must round-trip
  through env/CLI/API like every other CDB-expressible setting.
- The MCP tool surface is a small set of verbs (`explain`, `validate`,
  `retrieve`, `execute`, `devices`, `discover`) mirroring the CLI/API — never one
  tool per RouterOS command. `validate` is a dry-run (`:parse` +
  `/console/inspect`) that must not mutate.
- **Transport is stdio only.** HTTP/remote access is owned by the proxy surface
  (`src/webproxy.ts`), which fronts the same CDB; the MCP server grows no HTTP
  listener of its own. One surface owns network exposure.
- The server publishes read-only MCP resources `centrs://devices` (the active
  CDB's allowlist, no passwords) and `centrs://errors` (the error-code catalog →
  details URLs), and its `instructions` point at them so a client discovers the
  allowlist and error contract without guessing.

## Protocol selection

Per-operation preferences, downgrade order in parens:

| Operation | Preferred | Downgrade order |
| --------- | --------- | --------------- |
| retrieve  | rest-api, native-api; snmp for OID/MIB reads (future) | rest-api, native-api |
| execute   | native-api → rest-api → mac-telnet | native-api, rest-api, mac-telnet, ssh, romon, winbox-terminal |
| terminal  | ssh | mac-telnet (L2 only when ssh fails or MAC given) |
| transfer  | ssh / scp | rest-api files (small only) |
| discover  | mndp | (not a transport for command operations) |

Rules:

- `retrieve` is read-only (rest-api or native-api only). `execute` is the read
  and write surface; there is no `update` operation. Writes (add/set/remove)
  ride `execute`.

- Never silently downgrade across `--via`. If the caller pinned `--via rest-api`
  and REST cannot do the operation, error out with a `transport/*` code.
- Auto-selection (no `--via`) may downgrade *within* the table above, but every
  hop is reported in `meta.warnings` with the reason.
- SNMP is retrieve-only: `retrieve <router> snmp <oid|MIB name>` resolves
  names through a MikroTik MIB cache downloaded from mikrotik.com. It is not an
  execute or write surface.
- SSH, mac-telnet, RoMON, and WinBox Terminal are execute surfaces, not
  retrieve surfaces. RoMON and WinBox Terminal are lower priority than
  mac-telnet until their validation and test harnesses are grounded.
- mac-telnet is the primary L2 execute path; it is the default for execute when
  the target is an unresolved MAC address. If IP-level access is desired, the
  caller must explicitly opt into ARP-based MAC → IP resolution.

REST-specific constraint: RouterOS REST has a 60-second hard timeout. Do not
let `--timeout` exceed 60s when `via=rest-api`; reject with a clear error.
Other transports may accept longer timeouts.

## Done definition

A feature is done when its **CHR integration test is green** against a real
RouterOS CHR booted by `@tikoci/quickchr`. Not when code exists. Not when unit
tests pass. Not when the spec says so.

`docs/MATRIX.md` is the single source of truth for what is done. Cell states:

- `not-started` — no code, no design
- `designed` — `commands/<name>/README.md` describes intent and flags
- `coded` — implementation exists in `src/`
- `CHR-passed` — every example in `commands/<name>/examples.md` runs green
  against CHR via `bun run test:integration`

A cell advances only with the matching evidence in the same change. A commit
that advances a cell must include the test name and CHR version.

## Boundaries

centrs does:

- Resolve devices/groups from explicit input, env, CDB, MNDP cache.
- Choose protocols per the table above and configure them.
- Validate before execute; re-validate server-side immediately before run.
- Return structured envelopes with provenance and warnings.
- Use the WinBox CDB at its well-known location as the device datastore and
  cache; overlay centrs metadata via comment-kv and groups.

centrs does not:

- Replace RouterOS syntax with high-level abstractions.
- Treat passive discovery (MNDP) as authoritative inventory.
- Run write-shaped operations without an explicit target and validation policy.
- Make generated output the hand-edited source of truth.

## Invariants

- One settings vocabulary across API/CLI/MCP/TUI/proxy.
- Friendly, structured errors are part of the API contract — not optional polish.
- Help text, source reporting, redaction, and bug-report envelopes are
  shared-core, not per-frontend.
- Integration tests prefer real CHR via `quickchr` over elaborate mocks when
  behavior depends on RouterOS.
- Generated docs are preferred when the source of truth is code, CLI metadata,
  or schema.

## Adjacent projects (grounding sources)

- `tikoci/rosetta` — RouterOS docs / RAG.
- `tikoci/restraml` — REST schema and inspect output.
- `tikoci/m2ir` — protocol IR (WinBox, etc.). Not an accessible source for the
  RouterOS error-string vocabulary; ground error mappings on live CHR strings.
- `tikoci/lsp-routeros-ts` — canonicalization, parse-validation patterns.
- `tikoci/quickchr` — CHR-backed integration test harness.

When one of these owns a question, defer to it instead of restating here.

### Canonicalizer ownership

`rosetta`/`lsp-routeros-ts` own the shared, pure command canonicalizer
(`canonicalize.ts` → `{ path, verb, args }`); centrs may align with it for
**canonicalization**, but **centrs owns the script-vs-structured execution
gate**. That gate (`canonicalizeExecuteCommand` + `isWriteShaped`) is the
load-bearing discriminator for validation and the write-confirmation prompt;
widening what counts as `structured` is a product regression. The shared parser
is intentionally prose-tolerant and multi-command, so it must never be used as
the structured-mode predicate. The gate's behavior is pinned by
`test/unit/execute-canonicalize-contract.test.ts`.

centrs deliberately does **not** vendor the shared parser yet. Preconditions for
adopting it: (1) the legacy contract above stays green (no gate widening);
(2) the vendored file is clean under centrs's strict `tsconfig` or explicitly
quarantined with justification; (3) `lsp-routeros-ts` also vendors/consumes the
same parser shape, so it is genuinely shared rather than a premature first
copy.
