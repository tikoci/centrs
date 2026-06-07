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
2. Config file: `${XDG_CONFIG_HOME:-~/.config}/tikoci/centrs.env` — a
   dotenv-style `CENTRS_*=value` file centrs reads at startup, holding
   centrs-only **global** preferences (default discovery window, default
   `--format`, concurrency, …) that have no per-device home in the CDB. Its
   values are tier-2 *defaults*: real `CENTRS_*` process-env (tier 4) and CLI
   flags (tier 5) still override them, so centrs applies the file's keys as
   fallbacks rather than injecting them into `process.env`. It is **optional**
   (a missing file is never fatal; built-in defaults apply), needs **no new
   dependency** (plain `KEY=value` lines, not a parsed config format), and is
   **not** an inventory or credential store — per-device settings stay in the CDB.
   `--skip-env-file` (and `CENTRS_SKIP_ENV_FILE=1`) bypasses it for tests and
   dev-agent runs. The `centrs config` command is the front-end that reads and
   writes this file (and the `__default__` record); hand-editing also works.
3. CDB comment-kv metadata
4. Environment variables (`CENTRS_*`)
5. CLI flags / API call args

`meta.settings` reports the winning source for each resolved setting.

### Identity and CDB

The `<router>` argument may be: an IP, a DNS name, a MAC, or an **identity**
(the device's `/system/identity`). It is resolved through the CDB (then through
ARP / MNDP-derived metadata as fallbacks once implemented).

The WinBox CDB has no dedicated "name" field. Its natural record identity is the
**(target, user)** pair (grounded on WinBox behavior: "Save to list" with the
same address but a different user creates a *second* record, not an update). So
the same address saved under two users is two legitimate records, not a
duplicate; `group` is a flat attribute, never part of the key. centrs resolves
`<router>` against the `target` field **and** a small set of comment-kv **lookup
keys**: `identity=`, `mac=`, `ip=`. Whichever identifiers are not the `target` ride the comment as
lookup keys, so one record is resolvable by identity **or** IP **or** MAC **or**
DNS-name regardless of which one is stored as `target`. (`identity` mirrors
RouterOS `/system/identity` and is deliberately allowed to be non-unique;
collisions resolve through the ambiguity path below.) These lookup keys are the
one sanctioned exception to "the comment is free text"; every other comment-kv
token stays inert metadata.

CDB resolution:

- Default location: `~/.config/tikoci/winbox.cdb` (XDG Base Directory).
- `--cdb-file` / `CENTRS_CDB_FILE` overrides the location.
- If the CDB is encrypted, `--cdb-password` / `CENTRS_CDB_PASSWORD` (or
  `Bun.secret()` for the CLI, when wired) decrypts.
- Providing `--cdb-password` against an unencrypted CDB is a **warning**, not
  an error; the call still succeeds.
- An identity/target not found in the CDB is an error unless `--username` /
  `--password` were also provided (or a `__default__` record supplies them —
  see below).
- A `<router>` that matches more than one record (an address with two users, or
  a duplicated `identity=`) is `identity/ambiguous` in non-TTY mode; `--match`
  pins the choice by `user` and/or record-type. centrs does not heuristically
  pick among genuine duplicates.
- For a MAC target, CDB wins first. If no CDB record matches, `retrieve` may
  opt into local ARP resolution to obtain an IP-level target; `execute`
  defaults to mac-telnet unless the caller explicitly asks to resolve via ARP.
- `discover --save` writes MNDP-derived targets into CDB with
  provenance metadata and default `group=discovered`; discovery remains a hint
  source, not authoritative inventory. De-duplication of saved records is keyed
  on the **MAC** (globally unique); `identity` is written as a resolution handle
  but is never the de-dupe key, because factory-default devices all report
  `MikroTik`.

#### Default-device record (`__default__`)

A reserved CDB record (`target=__default__`, optionally `group=default`) supplies
fallback metadata + username/password for a resolved device whose own record
leaves them unset. WinBox can edit it like any other record; sharing the CDB with
WinBox stays opt-in.

- Precedence, per field: per-call args → env (`CENTRS_*`) → the matched device
  record → the `__default__` record → built-in default. Inheritance is
  per-field (a device may inherit `password` from `__default__` but override
  `user`).
- It is **core** — honored by CLI, API, and MCP, not an MCP-only concept.
- **Allowlist boundary holds.** On the CLI/API, `__default__` may supply creds
  for *any* target (including one not in the CDB) — the CLI has no allowlist. On
  **MCP**, the CDB stays the allowlist: an unregistered target is still rejected
  with `cdb/target-not-registered`, and `__default__` only fills *missing* creds
  for an *already-registered* device. `__default__` never widens the MCP
  allowlist.

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
| stream    | native-api, ssh | (REST cannot follow — 60s cap; bounded or rejected) |
| execute   | native-api → rest-api → mac-telnet | native-api, rest-api, mac-telnet, ssh, romon, winbox-terminal |
| terminal  | ssh | mac-telnet (L2 only when ssh fails or MAC given) |
| transfer  | ssh / scp | rest-api files (small only) |
| discover  | mndp | (not a transport for command operations) |

Rules:

- `retrieve` is read-only (rest-api or native-api only). `execute` is the read
  and write surface; there is no `update` operation. Writes (add/set/remove)
  ride `execute`.

- `stream` is a **read-only** follow/streaming surface (RouterOS `print
  follow`/monitor/sniffer with `once`/`follow`/`duration=`/
  `freeze-frame-interval=`). It emits a sequence of envelopes as NDJSON,
  terminated by a summary envelope (frame count, duration, stop reason); a
  mid-stream error is a frame, and the exit code reflects whether the stream
  *started* cleanly. True follow cannot ride REST (60s hard cap), so it is
  native-api/ssh; `--via rest-api` is bounded-or-rejected. Bounded single-shot
  reads stay on `retrieve --once`; interactive PTY stays on `terminal`.

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
