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

centrs also speaks a small set of MikroTik **peer protocols** that are *not*
RouterOS-command transports — currently the **bandwidth test** (`btest`), which
mirrors `/tool/bandwidth-test` and `/tool/bandwidth-server`. This is a
deliberate, separate capability axis (*measurement*, not "run a validated
command"): centrs still gives structured envelopes, identity resolution, and
friendly errors, but the "validate a RouterOS-shaped command" gate below does
**not** apply to it (see "Validation is the product" and Protocol selection's
`measure` row).

## Validation is the product

Every RouterOS-shaped call goes through canonicalize → validate → run →
re-validate-server-side. Validation is not optional polish.

- `retrieve` and other read-shaped calls validate against
  `/console/inspect request=syntax path=...,print` (path joined by commas) and
  attribute inspection. The path syntax (commas, no leading slash, last token
  is the verb) is part of the validator contract.
- `execute` and other CLI-shaped calls validate with `:put [:parse "..."]` plus
  a semantic gate. **How `:parse` surfaces an error is transport-specific**
  (grounded on CHR 7.23.1): `:parse` *does* reject an unknown attribute
  (`bad parameter <name>`) and malformed CLI (`syntax error`), but over REST that
  text rides the **HTTP-200 `ret` value** (no error status), and over the
  **native API** `:put [:parse]` returns an opaque `*NN` handle that reveals
  nothing at all. centrs's REST/native syntax gate runs `:parse` but does not
  read the `ret`, so for those transports the unknown-attribute catch comes from
  the separate **`/console/inspect`** semantic gate (or the server's own
  write re-validation); the `:parse` round-trip there mainly backstops transport
  errors and the local quote preflight. Over **mac-telnet** the interactive
  console *prints* the `:parse` result, so centrs reads it and a single console
  `:parse` covers both syntax and the unknown-attribute (semantic) gate — no
  `/console/inspect` table needed. In every case a clean parse is necessary, not
  sufficient on its own; semantic validation is a distinct, transport-appropriate
  step (`/console/inspect`, the console `:parse` text, or server re-validation).
- **Peer-measurement commands (`btest`) are exempt from this gate** — they issue
  no RouterOS command, so they validate *option-grammar* + the **EC-SRP5** auth
  exchange instead (the envelope, identity-resolution, and friendly-error
  contract still hold; only the RouterOS-command gate is absent). The grammar
  rules are in `commands/btest/README.md`.
- A failing validator is a real result. Surface it with the structured error
  envelope below — do not bypass.

There is no `update` verb: generalizing RouterOS add/set/remove into one abstract
write would need too many heuristics, so writes ride `execute`'s
canonicalize → validate → run path while `retrieve` stays read-only (see Protocol
selection).

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
  tips?: Tip[],                 // advice, not anomalies (no username set, no CDB found, …)
  error?: CentrsError,          // present iff ok=false
  meta: {
    target: { ... },            // resolved target + provenance (where each field came from)
    via: RouterOsProtocol,      // chosen protocol id
    settings: { ... },          // settings winners + sources (env / cli / cdb / default)
    validation?: { ... },       // validator name + result, if validation ran
    timing?: { ... },           // request/response durations
    truncated?: { ... },        // populated when --max-bytes/--max-rows clipped output
  }
}
```

Notes:

- "Success with footnotes" is supported: `ok: true` may carry warnings.
- `warnings` and `tips` are both always present (`[]` when empty) so consumers
  never branch on existence. They are distinct on purpose: a **warning** is a
  non-fatal anomaly about *this* result (stale cache, unused `--cdb-password`); a
  **tip** is advice that is explicitly *not* an error or anomaly (no username
  set, no CDB found, consider a default device). The "this is not a problem,
  just a pointer" signal is the whole reason tips are a separate channel rather
  than folded into warnings. A `Tip` has the same shape as a warning
  (`{ code, message, fix? }`) with `tip/*` codes and a `details_url`.
- CLI render must be lossless against the JSON envelope; `--format json` and
  `--format yaml` are aliases that select serialization, not different shapes.
  Text mode renders tips under a `Tips:` footer, distinct from warnings. This
  lossless rule applies to **stdout** only: **stderr** carries progress and
  interactive prompts (discover scan progress, write/ambiguity confirmation) and
  is exempt — use it sparingly, since most operations are fast.
- `data` is the only field whose *shape* varies by command. Everything else —
  including `warnings` and `tips` — is invariant in shape; only contents differ.

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

The bug-report renderer is invoked **inline** via `--bug-report` on any command —
there is no separate `bug-report` verb. It re-renders the just-produced envelope
with `redactable_fields` stripped and each error's `details_url` kept, so a
shareable report needs no extra capture step (the envelope is already rich enough
to be the report).

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
2. Config file: `${XDG_CONFIG_HOME:-~/.config}/tikoci/centrs.env` — optional
   dotenv-style `CENTRS_*=value` **global** defaults (centrs-only preferences
   with no per-device home; **not** an inventory or credential store — per-device
   settings stay in the CDB). Applied as fallbacks, never injected into
   `process.env`. The `centrs config` command is its front-end; the file
   mechanics, `--skip-env-file`, and the settings-key vocabulary live in
   `commands/config/README.md`.
3. CDB comment-kv metadata
4. Environment variables (`CENTRS_*`)
5. CLI flags / API call args

`meta.settings` reports the winning source for each resolved setting.

### Identity and CDB

The `<router>` argument may be an IP, a DNS name, a MAC, or an **identity**
(the device's `/system/identity`); centrs resolves it through the CDB (then
through ARP / MNDP-derived metadata as fallbacks, once implemented). Two
principles are load-bearing:

- **Record identity is the `(target, user)` pair** — matching WinBox, the same
  address saved under a different user is a second record, not an update.
  `group` is a flat attribute, never part of the key.
- **The CDB is both the device datastore and the credential store.** The WinBox
  CDB file at its well-known location *is* the inventory; there is no separate
  cache. centrs-specific meaning is overlaid through an allowlist of comment-kv keys —
  the lookup keys `identity=`/`mac=`/`ip=` (the one sanctioned exception to "the
  comment is free text") plus override keys like `via`/`port`/`ssh-key`; every
  other comment token stays inert. **Anything expressible in the CDB must also
  be expressible via env/CLI/API**, so tests and ad-hoc use never require one.
  `dude.db` import is out of scope (→ `tikoci/donny`).

The lookup-key grammar, the CDB resolution and ambiguity rules (`--match`,
`identity/ambiguous`, `--prefer-family`), the comment-kv allowlist, encrypted-CDB
handling, and the atomic write strategy live in `commands/devices/README.md` —
`devices` is the registry command and the CDB's only writer.

#### Default-device record (`__default__`)

A reserved CDB record (`target=__default__`) supplies fallback metadata +
credentials, **per field**, for a resolved device whose own record leaves them
unset. Precedence is per-field: per-call args → env (`CENTRS_*`) → matched device
record → `__default__` → built-in default. It is **core** (honored by CLI, API,
and MCP) and **never widens the MCP allowlist**: on MCP an unregistered target is
still `cdb/target-not-registered`, and `__default__` only fills *missing* creds
for an already-registered device. Create/edit it like any record; mechanics and
examples are in `commands/devices/README.md`.

Group selectors (e.g. `--group prod-edge`) target CDB groups so a single
`retrieve`/`execute`/etc. fans out to multiple routers. Group output shape
must round-trip through the same envelope.

#### Target selection grammar

One grammar across every non-terminal command. A call selects targets from any
mix of: `<router>` positionals (one or more), repeatable `--group <name>`,
`--all` (every CDB record), `--default` (the `__default__` record), and
repeatable `--where <attr>=<value>` — a **device-class** selector that matches
CDB-stored facts/comment-kv (e.g. `--where board=RB5009`), AND-combined across
repeats. The union is **de-duped by CDB record index** and run through the same
per-target pipeline; the `data` array is reassembled in resolved record order,
not completion order, so repeated runs diff cleanly. Destructive multi-target
operations (e.g. `devices remove` across a group) require `--force`. `terminal`
and single-session `stream` are not fan-out surfaces and reject N>1 with
`usage/fanout-not-supported`.

`--where` filters *which devices* by CDB-stored facts; keep it distinct from
`retrieve`/`execute`'s `--query`/`--filter`, which filter *RouterOS rows* in the
response. Two layers, two flag families.

`--group` is purely a **selector** in this grammar; the group *field* is written
by a distinct `--new-group` flag on `devices add`/`set`, so record selection and
field-setting never collide on one flag.

### MCP surface: the CDB is the allowlist

The MCP frontend (`commands/mcp/`) is an adapter over this core, not a new set of
RouterOS semantics. Two boundaries are load-bearing:

- **Authorization is the CDB allowlist.** RouterOS-facing tools resolve targets
  through the CDB only; an unregistered target is rejected
  (`cdb/target-not-registered`), and `__default__` never widens the allowlist (see
  Identity and CDB). The off-by-default `--allow-adhoc-targets` flag is reserved
  for future inline-target flows — today no RouterOS-facing tool exposes an inline
  host+credential schema, so the CDB allowlist is the only active target source.
- **Transport is stdio only.** HTTP/remote access is the proxy surface's job
  (`src/webproxy.ts`), which fronts the same CDB; the MCP server grows no listener
  of its own. One surface owns network exposure.

The scoped tool surface (verbs mirroring the CLI/API, never one tool per RouterOS
command), the per-device `mcp=ro|rw` + `confirm: true` write gate, the
`centrs://devices` / `centrs://errors` resources, and the full safety model are in
`commands/mcp/README.md`.

## Protocol selection

Per-operation preferences, downgrade order in parens:

| Operation | Preferred | Downgrade order |
| --------- | --------- | --------------- |
| retrieve  | rest-api, native-api; snmp for OID/MIB reads (future) | rest-api, native-api |
| stream    | native-api, ssh | (REST cannot follow — 60s cap; bounded or rejected) |
| execute   | native-api → rest-api → mac-telnet | native-api, rest-api, mac-telnet, ssh, romon, winbox-terminal |
| terminal  | ssh | mac-telnet (L2 only when ssh fails or MAC given) |
| transfer  | size/direction-aware: rest-api/native-api for ≤60 KB writes & all reads (chunked), sftp for large uploads | sftp ⇄ rest/native by size; scp · fetch · ftp explicit-only |
| discover  | mndp | (not a transport for command operations) |
| measure   | btest | (explicit-only — no downgrade) |

Rules:

- **Read vs write:** `retrieve` is read-only (rest-api/native-api); `execute` is
  the read **and** write surface — writes (add/set/remove) ride `execute`, and
  there is no `update` operation.
- **Never silently downgrade across `--via`.** If the caller pinned a transport
  that cannot do the operation, error out with a `transport/*` code.
  Auto-selection (no `--via`) may downgrade *within* the table, but every hop is
  reported in `meta.warnings` with its reason.
- **Execute vs retrieve surfaces:** native-api, rest-api, ssh, mac-telnet (and
  later RoMON / WinBox Terminal) are execute surfaces; SNMP is **retrieve-only**.
  mac-telnet is the default execute path for an unresolved-MAC target — IP-level
  access needs explicit ARP opt-in.
- **`measure` (btest) is explicit-only** — never in the auto-select/downgrade
  chain, never a substitute, and no other command rides it.
- Per-command selection **depth** lives in the command READMEs: `stream`'s
  follow/NDJSON contract and the REST-cannot-follow constraint
  (`commands/stream/README.md`), `transfer`'s size/direction-aware method
  selection and the explicit-only `scp`/`ftp`/`fetch`
  (`commands/transfer/README.md`), SNMP's MIB-cache
  (`commands/retrieve/README.md`), and btest's port/auth
  (`commands/btest/README.md`).

REST-specific constraint: RouterOS REST has a 60-second hard timeout. Do not
let `--timeout` exceed 60s when `via=rest-api`; reject with a clear error.
Other transports may accept longer timeouts.

### Transport trust (TLS / SSH host keys)

One opt-out across every transport: `--insecure` (`CENTRS_INSECURE`, CDB
`insecure=` comment-kv). Default is **verify**; `--insecure` disables peer
verification and adds a `transport/insecure-trust` warning to the envelope so the
downgrade is always visible. Because RouterOS ships **self-signed** certificates
and host keys, the *default posture per transport follows that transport's
ecosystem norm* rather than one literal value:

- **TLS** (REST `https`, native-api `api-ssl`) **verifies** by default; a
  self-signed cert fails with `transport/tls-certificate` whose remediation names
  `--insecure`. (Both transports honor the same knob — previously native-api
  silently accepted any cert; that is fixed.)
- **SSH host keys** (sftp/scp) default to **trust-on-first-use**
  (`StrictHostKeyChecking=accept-new` into the user's `known_hosts`): a new key is
  accepted, a *changed* key fails with `transport/host-key-mismatch`. `--insecure`
  disables the check entirely. TOFU is the universal SSH norm, so the SSH default
  is laxer than the TLS default by design.

SSH identity selection: the `sshKey` setting (`--ssh-key`/`CENTRS_SSH_KEY`/CDB
`ssh-key=`) carries a private-key **path only** — never key material; when unset,
the host SSH agent / `~/.ssh/config` is used. RouterOS refuses password login once
an SSH key is set for a user (`password-authentication=yes-if-no-key`, the
default), so key auth is the normal sftp path.

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
- Speak MikroTik peer-measurement protocols on explicit request — the bandwidth
  test (`btest`), as both client and server — with the same envelope / identity /
  error contract (but not the RouterOS-command validation gate).

centrs does not:

- Replace RouterOS syntax with high-level abstractions.
- Treat passive discovery (MNDP) as authoritative inventory.
- Run write-shaped operations without an explicit target and validation policy.
- Make generated output the hand-edited source of truth.

### Network listeners

centrs opens a network listener in exactly two sanctioned places: the **proxy**
surface (HTTP / remote access; `src/webproxy.ts`) and the **btest server**
(`centrs btest server`, TCP/UDP port 2000). The btest server is an **explicit,
foreground, user-invoked** command — not an always-on daemon, and not the proxy.
It **binds loopback by default** (`--bind` to expose), **requires auth by
default** (`authenticate=yes`, mirroring RouterOS), and is security-sensitive
surface: treat credentials as redactable (`SECURITY.md`). The MCP server stays
stdio-only and grows no listener of its own.

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
- `tikoci/m2ir` — protocol IR (WinBox, etc.), and the home for the
  declarative "schema-as-data" approach to representing protocol internals
  (consult it when WinBox-terminal / RoMON / heavy protocol work lands, rather
  than hand-rolling protocol knowledge in centrs). Not an accessible source for
  the RouterOS error-string vocabulary; ground error mappings on live CHR
  strings.
- `tikoci/lsp-routeros-ts` — canonicalization, parse-validation patterns.
- `tikoci/quickchr` — CHR-backed integration test harness.

When one of these owns a question, defer to it instead of restating here.

External reference implementations to compare centrs protocol/transport work
against (SSH patterns, native-API behavior, CDB format, WinBox framing) are kept
as bibliography entries in `GLOSSARY.txt` — e.g. `netmiko`,
`terraform-provider-routeros`, `librouteros-api`, `RouterOS_Tools`,
`Winbox_Protocol_Dissector`.

### Canonicalizer ownership

centrs owns the **script-vs-structured execution gate** — the load-bearing
discriminator for which validation runs and whether the write-confirmation prompt
fires; widening what counts as `structured` is a product regression. The shared,
pure command canonicalizer that `rosetta` / `lsp-routeros-ts` publish is for
canonicalization only, never the structured-mode predicate. The gate contract,
its pinning test, and the parser-vendoring preconditions are documented in
`commands/execute/README.md` and the `canonicalizeExecuteCommand` doc-comment
(`src/execute.ts`).
