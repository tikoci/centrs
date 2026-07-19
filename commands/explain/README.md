# explain

Analyze a RouterOS command **before** anything runs it: canonical form,
LSP-like token spans and diagnostics, schema facts (which commands, arguments,
and values are valid at a path), and completion-style candidates for building
the right command — offline from a schema snapshot, or version-exact against a
live device. `explain` is the "E" of the explain → validate → run split
(constitution: validation): the cheap, safe knowledge tier in front of the
runners (`execute` / `api` / `retrieve`).

Status: `designed` over `rest-api` and `native-api` — the transports the live
inspection probes ride; every other cell is `—`. The offline mode is
transport-less. See `docs/MATRIX.md` for the row. **This spec is a strawman**:
it fixes intent, boundaries, and evidence sources, and presents the surface
options that still need a design round before code — every flag and verb name
here is provisional (see [Open questions](#open-questions--design-rounds)).
Load-bearing rules — envelope, errors, settings precedence, identity,
validation, protocol selection — live in
[`docs/CONSTITUTION.md`](../../docs/CONSTITUTION.md).

## Why (grounding)

- `~/GitHub/bench-routeros-tools` (`REPORT.md`) grounds the split empirically:
  agents need a cheap, safe knowledge/validation tier gating a thin runner, and
  a handful of verbs over canonical `{path, verb, args}` beats per-command
  tools. It also measured the **inspect-vs-runtime gap** (`/console/inspect`
  accepted `blackhole=yes` where the runtime wanted the bare flag): schema
  acceptance is necessary, never sufficient.
- The wire-format research is done and public:
  [`routeros-syntax-inspection`](https://github.com/tikoci/routeros-skills/tree/main/routeros-syntax-inspection)
  (probe selection, highlight/parseIL/completion/child/syntax semantics,
  hazards, provenance rules) and
  [`routeros-command-tree`](https://github.com/tikoci/routeros-skills/tree/main/routeros-command-tree)
  (tree traversal, schema generation), both grounded by full-corpus captures in
  [tikoci/lsp-routeros-ts `docs/`](https://github.com/tikoci/lsp-routeros-ts/tree/main/docs)
  (913 scripts × 7.9.2/7.23.2/7.24rc2). This spec cites those references
  rather than restating them; they are the canonical wire truth.
- Decisions already locked in #90: `validate` stays **boolean** (the dry-run
  gate inside `execute`/`api` and `centrs_validate`); `explain` is the surface
  that carries richness levels; centrs is the **canonicalizer/explain owner**
  and `lsp-routeros-ts` eventually becomes a thin shim over the centrs library.
- Boundary decisions from rosetta B-0013 (#175): rosetta owns *static,
  docs-grounded* explanation — prose, URLs, version history — and never grows
  validate/run; centrs owns canonicalization and **anything device-aware**, and
  consumes rosetta for doc enrichment rather than duplicating retrieval.

## Where `explain` sits

- **Never executes, never mutates.** All live probes (`/console/inspect`
  highlight/completion/syntax/child and `:put [:parse …]`) are read-only
  inspection. Execution-based probes (required-argument discovery via
  deliberate errors) are out of scope — they belong to research tooling, not
  this verb.
- **`validate` is unchanged.** `--validate` remains the boolean gate on the
  runners; `explain` is what you call when you want to know *why*, or to build
  the command in the first place. Internally they share machinery; externally
  they stay distinct surfaces (constitution: validation).
- **The structured-mode gate stays authoritative.** `explain` exposes the
  canonicalizer's verdict (`mode`, `writeShaped`) but must not widen what
  counts as `structured` (constitution: canonicalizer ownership).
- **Passing `explain` is not a promise the router will accept the command.**
  Every result carries this asymmetry explicitly (see
  [Result shape](#result-shape-sketch)); only `execute`/`api` against a real
  target proves runtime acceptance.
- **Library-first.** The deliverable is exported functions on `@tikoci/centrs`
  that need no CLI and (offline) no CDB; the CLI verb and the MCP tool are thin
  adapters. This is what lets `lsp-routeros-ts` later consume centrs instead of
  owning its own analysis core.

## Three questions, one pipeline

An agent (the primary caller) asks `explain` three kinds of question before
touching `execute` / `api` / `retrieve`:

1. **Check** — *"is this command right?"*
   `/ip/route add dst-address=10.9.0.0/16 blackhole=yes` → canonical
   `{path, verb, args, mode, writeShaped}`, per-token spans, diagnostics with
   the exact error location, schema facts for each argument.
2. **Assist** — *"what can come next?"*
   `/ip/firewall/filter add ch` + cursor → completion candidates
   (`chain=`, …) with provenance, so the caller composes a correct command
   instead of guessing and retrying.
3. **Describe** — *"what exists at this path?"*
   `/ip/firewall/filter` → child commands, argument names, value types, enum
   candidates, and (optionally) the docs link — the data an agent wants before
   writing anything at all.

A bare menu path is just a short command prefix, and "assist" is analysis of
partial input plus candidates — so one analysis pipeline serves all three
intents. That observation drives the strawman surface below.

## Evidence modes

| Mode | Trigger | Sources | Provenance label |
| ---- | ------- | ------- | ---------------- |
| **Offline** (default) | no `<router>` given | centrs canonicalizer (segmentation, path/verb/args split, script-vs-structured, write-shape) + a **schema snapshot** derived from restraml `deep-inspect.json` (path existence, argument names, types, enum values) | `static-schema`, stamped with snapshot version |
| **Live** | `<router>` given | `request=highlight` (byte-classified spans, first hard error), `:parse` (structure, error line/column), `request=completion` / `syntax` / `child` (candidates, structured help, children) | `live-inspect`, stamped with the device's version |

Offline diagnostics are phrased as snapshot facts (`not present in the 7.22
snapshot`), never as device facts; live results are version-exact but
device-specific. When both are available the live device wins for structure
and existence; static sources win only for the prose/history they uniquely
carry (the B-0013 / `rosetta-alignment` rule).

A live target arrives through the **same resolver as every other command**
(CDB name/MAC/group keys, `--quickchr`, future TikTOML — #134/#174): a
target-aware `explain` gets provider targets for free and adds no bespoke
resolution path. Fan-out does not apply — `explain` takes at most one router
and rejects selectors with `usage/fanout-not-supported`, like `terminal`.

Implementation-normative safety rules (evidence in the skill/LSP references):
per-probe timeouts always; skip scripting-keyword paths for `syntax`/
`completion` on ≤ 7.20.8 (REST-server deadlock, fixed 7.21.4, SUP-127641);
route input past the 32,767-byte highlight cap to `:parse` or report
truncation — never analyze a silent prefix; offsets are **UTF-8 byte** offsets
over ASCII-normalized input and the normalization is recorded; `[]`, timeout,
and transport failure stay distinct outcomes.

## Surface options (the design decision this spec queues)

### Option A — one verb, facet flags (strawman)

```bash
centrs explain "<input>" [<router>] [flags]
```

`<input>` is a command, a script fragment (`--file` / stdin for scripts), or a
bare menu path. Base output is always the cheap tier: canonical form + spans +
diagnostics. Facet flags opt into heavier evidence:

| Flag | Adds | Cost |
| ---- | ---- | ---- |
| *(base)* | canonical form, spans, diagnostics | offline: pure; live: highlight + `:parse` |
| `--complete [--cursor <byte>]` | continuation candidates at the cursor (default: end of input) | live: one `completion` probe; offline: snapshot lookup |
| `--schema` | full path schema: children, arguments, types, enums | live: `child`/`syntax`/`completion` probes; offline: snapshot |
| `--docs` | docs URL/title/prose enrichment | rosetta artifact (optional, see below) |
| `--deep` | all of the above | — |

Pros: one verb (scoped-verb philosophy), one pipeline, the three intents are
just input shapes; `gh api`-like learnability. Cons: flag surface must stay
disciplined; "describe a path" via a positional that *looks* like a command
may need explicit `--at <path>` disambiguation for odd inputs.

### Option B — sub-verbs

```bash
centrs explain check "<input>" [<router>]
centrs explain complete "<input>" [--cursor <byte>] [<router>]
centrs explain path /ip/firewall/filter [<router>]
```

Pros: explicit intents, level-aware help per sub-verb, MCP tools map 1:1.
Cons: three surfaces to document/version; the intents share ~all their
plumbing; sub-verb sprawl for what is one analysis with facets.

### Option C — fold into the runners (`execute --explain`) — rejected

Rejected here so the round starts from a real position: the bench grounds a
*separable* cheap tier (an agent must be able to explain without holding run
authority); offline explain has no runner to ride; and MCP already serves
`centrs_explain` with no CDB — a flag on `execute` cannot do that.

**Strawman recommendation: Option A**, with Option B's `path` ergonomics kept
in mind (`--at` or an accepted bare-path positional). Exit codes follow the
`check` pattern: `0` clean, `2` when diagnostics meet `--fail-on
<error|warning|never>` (default `error`), `1` on command failure.

## Result shape (sketch)

Standard envelope (constitution: result envelope); `data` sketch:

```json
{
  "input": { "bytes": 58, "normalized": false, "truncated": false },
  "canonical": { "path": "/ip/route", "verb": "add", "args": { "dst-address": "10.9.0.0/16", "blackhole": "yes" }, "mode": "structured", "writeShaped": true },
  "spans": [ { "start": 0, "end": 9, "class": "path" } ],
  "diagnostics": [ { "severity": "warning", "code": "explain/schema/unknown-argument", "span": { "start": 42, "end": 55 }, "message": "…", "source": "static-schema" } ],
  "schema": { "path": "/ip/route", "exists": true, "args": [ { "name": "dst-address", "type": "ip-prefix" } ] },
  "completion": [ { "value": "chain", "kind": "argument", "source": "live-inspect" } ],
  "docs": { "url": "…", "title": "…" },
  "target": { "resolved": "chr1", "version": "7.23.1" },
  "runtimeAcceptance": "not-proven"
}
```

- **Every derived fact keeps provenance** — source probe (or snapshot), basis
  (direct response vs derived vs docs), version stamp, normalization,
  truncation, outcome. The `RouterOsSyntaxEvidence` contract in
  lsp-routeros-ts `docs/syntax-inspection-map.md` is the adaptation source.
- Diagnostics are slash-namespaced (`explain/<source>/<slug>`), carry byte
  spans (or line/column from `:parse`), and follow the standard error-model
  severity channels.
- `runtimeAcceptance: "not-proven"` is structural, not boilerplate: it is the
  inspect-vs-runtime gap made machine-readable.
- Live-state token classes (`obj-disabled`, `obj-dynamic`, …) surface as
  facts, not errors; severity policy belongs to the caller.

## MCP and library surfaces

- `centrs_explain` today wraps `canonicalizeExecuteCommand` (offline, no CDB —
  the only tool that serves without one). It grows toward this spec: same
  offline default, optional facets, and optionally a CDB-resolved target for
  live evidence. Whether that is one richer tool or a second target-aware tool
  is an open question; either way the no-CDB offline path must survive, and
  the MCP adapter must not widen the structured gate.
- Library (sketch): `explainCommand(input, opts)` pure/offline;
  `explainCommand(input, { target, facets })` live. `lsp-routeros-ts` is the
  intended external consumer (hover/diagnostics/completion over these calls);
  an LSP *protocol* surface on centrs stays out of scope (#90).

## Non-goals

- No LSP server in centrs — the LSP is a future consumer, nothing more.
- No execution probes; no state mutation of any kind.
- No fan-out.
- No docs retrieval/search engine — rosetta owns retrieval; centrs consumes.
- No promise of enum exhaustiveness or of the upstream `completion-tricks`
  synthetic-probe recipes (still open research in lsp-routeros-ts
  `BACKLOG.md`) — candidates are labeled as observed, not closed sets.

## Definition of done and staging

`designed` on the strength of this README. When implementation starts, offline
examples gate via unit/fixture tests and each live cell advances to
`CHR-passed` only when its `examples.md` entries run green via
`bun run test:integration` (constitution: done definition). Suggested staging
(sequence, not schedule):

1. **Offline core** — canonicalizer verdict + segmentation + diagnostics; no
   snapshot yet. Smallest useful `explain`.
2. **Schema snapshot** — restraml-derived artifact; `--schema`/`--complete`
   offline.
3. **Live probes** — highlight + `:parse` (+ completion/child/syntax facets)
   over rest-api/native-api with the safety rules above.
4. **Docs enrichment** — rosetta integration (mechanism per open question).
5. **Library/LSP alignment** — export shape hardened against a real
   lsp-routeros-ts consumption spike.

## Open questions — design rounds

1. **Surface shape** — Option A (facet flags, strawman) vs Option B
   (sub-verbs); how a bare path is addressed (`--at` vs positional).
2. **Richness control naming** — facet flags (strawman) vs a numeric
   `--depth`; #90 recorded "`--format` levels", but `--format` should stay the
   text/json rendering switch (settings vocabulary) — resolve the wording.
3. **Snapshot artifact** — format (SQLite per house style vs JSON), size
   budget, distribution (bundled in the npm package vs fetched on first use vs
   pointed at a local restraml checkout), and version coverage (primary
   version only vs multi-version presence data).
4. **Rosetta integration mechanism** — vendored docs-links JSON vs shelling
   out to the planned one-shot `bunx @tikoci/rosetta … --json` (B-0013
   T-0032) vs optional local `ros-help.db` probe. Never a hard dependency.
5. **Span vocabulary** — expose RouterOS highlight classes raw (drift risk
   across versions) vs map to a stable centrs vocabulary the LSP and agents
   can rely on.
6. **Segmentation engine** — grow `canonicalizeExecuteCommand` vs adopt/vendor
   rosetta's pure `canonicalize.ts` (hardened, 61 tests, `confidence`,
   `extractMentions`) for step-1 segmentation, keeping centrs's gate
   authoritative either way. The long goal is **one** core in centrs.
7. **MCP shape** — extend `centrs_explain` in place vs add a target-aware
   sibling; interaction with `centrs_validate`.
8. **Version-drift facts** — should `--docs` (or a facet) surface added-in/
   removed-in/breaking-change history (rosetta `command_versions` /
   `changelogs`), and at which tier.
9. **Script-scale explain** — multi-statement `.rsc` input: statement
   segmentation is in scope for spans; how far block/scope analysis (parseIL
   depth) goes, and whether it stages after the LSP consumption spike.
