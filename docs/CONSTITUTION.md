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
- `execute` and other CLI-shaped calls validate against `:put [:parse "..."]`
  via `/rest/parse`. Parse is faster and more binary than inspect; prefer it
  when the command is CLI-shaped.
- A failing validator is a real result. Surface it with the structured error
  envelope below — do not bypass.

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

Two error sources must be visually distinguishable:

1. **centrs errors** — bad usage, validator rejection, transport plumbing.
2. **RouterOS errors** — surfaced by the router (HTTP 4xx/5xx, parse refusal,
   nova error). Map to a normalized `routeros/*` code; preserve the original
   string in `cause`.

Mapping RouterOS string errors to normalized codes is ongoing maintenance.
`tikoci/m2ir` tracks the nova-error vocabulary; consult it when extending.

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
3. Environment variables (`CENTRS_*`)
4. CLI flags / API call args

`meta.settings` reports the winning source for each resolved setting.

### Identity and CDB

The `<router>` argument may be: an IP, a DNS name, a MAC, or a **name**. A
name is resolved through the CDB (then through MNDP cache as a fallback once
implemented).

CDB resolution:

- Default location: `~/.config/tikoci/winbox.cdb` (XDG Base Directory).
- `--cdb-file` / `CENTRS_CDB_FILE` overrides the location.
- If the CDB is encrypted, `--cdb-password` / `CENTRS_CDB_PASSWORD` (or
  `Bun.secret()` for the CLI, when wired) decrypts.
- Providing `--cdb-password` against an unencrypted CDB is a **warning**, not
  an error; the call still succeeds.
- A name not found in the CDB is an error unless `--username` / `--password`
  were also provided.

CDB is the native credential store. Anything in CDB must also be expressible
via env/CLI/API for tests and ad-hoc use. `dude.db` import is out of scope here
and belongs to `tikoci/donny`.

Group selectors (e.g. `--group prod-edge`) target CDB groups so a single
`retrieve`/`execute`/etc. fans out to multiple routers. Group output shape
must round-trip through the same envelope.

## Protocol selection

Per-operation preferences, downgrade order in parens:

| Operation | Preferred       | Downgrade order                                  |
| --------- | --------------- | ------------------------------------------------ |
| retrieve  | rest-api (now) → native-api (later) | rest-api, native-api, ssh (cli-shaped) |
| update    | rest-api (now) → native-api (later) | rest-api, native-api, ssh             |
| execute   | native-api (later) → rest-api / ssh | rest-api, ssh, mac-telnet              |
| terminal  | ssh             | mac-telnet (L2 only when ssh fails or MAC given) |
| transfer  | ssh / scp       | rest-api files (small only)                       |
| discover  | mndp            | (not a transport for command operations)         |

Rules:

- Never silently downgrade across `--via`. If the caller pinned `--via rest-api`
  and REST cannot do the operation, error out with a `transport/*` code.
- Auto-selection (no `--via`) may downgrade *within* the table above, but every
  hop is reported in `meta.warnings` with the reason.
- mac-telnet is the only L2 path; it is the right choice when the target is a
  MAC address or when IP-level access is known broken and a MAC is on file.

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
- Cache local metadata in SQLite (preferred) when it improves UX.

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
- `tikoci/m2ir` — nova-error vocabulary and protocol IR (WinBox, etc.).
- `tikoci/lsp-routeros-ts` — canonicalization, parse-validation patterns.
- `tikoci/quickchr` — CHR-backed integration test harness.

When one of these owns a question, defer to it instead of restating here.
