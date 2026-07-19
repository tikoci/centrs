# explain

Analyze a RouterOS command **before** anything runs it: canonical form and
structure, LSP-like token spans and diagnostics, how the command would actually
run (`api`-able vs `execute`-required, including a rendered REST/`curl` form),
and — against a live device — what commands, arguments, and values are valid at
a path, with completion-style candidates for building the right command.
`explain` is the "E" of the explain → validate → run split (constitution:
validation): the cheap, safe knowledge tier in front of the runners
(`execute` / `api` / `retrieve`).

Status: `designed` over `rest-api` and `native-api` — the transports the live
inspection probes ride; every other cell is `—`. The offline mode is
transport-less. See `docs/MATRIX.md` for the row. A first design round
(2026-07-19, recorded in #90) settled the surface shape and the offline model;
**the spec is not yet ratified** — ratification waits on a canonicalization
grounding pass (see [Staging](#definition-of-done-and-staging)), and every
flag/field name here is still provisional.
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
- Decisions locked in #90: `validate` stays **boolean** (the dry-run gate
  inside `execute`/`api` and `centrs_validate`); `explain` is the surface that
  carries richness; centrs is the **canonicalizer/explain owner** and
  `lsp-routeros-ts` (and tikbook) eventually consume the centrs library
  instead of owning their own analysis core.
- Boundary from rosetta B-0013 (#175), sharpened by the 2026-07-19 round:
  rosetta owns *static, docs-grounded* explanation — prose, URLs, version
  history, "what version supports what" — and never grows validate/run; centrs
  owns canonicalization and anything device-aware. **centrs does not call
  rosetta, and does not consume restraml/rosetta schema data, for now**: the
  projects stay decoupled until centrs's final shape is known. At most,
  `explain` output may *steer* toward rosetta in a tip (e.g. "for docs/version
  history, ask rosetta"). Deeper integration (for example rosetta publishing
  stable GitHub-Pages links centrs help could cite) is future rosetta-side
  work, tracked there, not here.

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
  that need no CLI and (offline) no CDB; the CLI verb and the MCP tool are
  thin adapters. centrs ships no LSP server, but the library API must be able
  to **support one**: hover, diagnostics, completion, and semantic-token needs
  of `lsp-routeros-ts`/tikbook are first-class consumers of the export shape.

## Canonicalization is the core

The engine is a **grown `canonicalizeExecuteCommand`** (decision: grow the
in-repo canonicalizer; rosetta's pure `canonicalize.ts` is reference material
to borrow from as needed, with **no sync obligation** — centrs solves a
different problem and is expected to diverge). Target capabilities, beyond
today's path/verb/args split and script-vs-structured gate:

- **Structure, not just segmentation.** Parse RouterOS input into an AST-like
  structure so complex expressions, blocks, and scopes can be identified —
  including multi-statement `.rsc` scripts.
- **Sub-command resolution with re-constituted paths.** In
  `/ip/address remove [find comment=defconf]`, the inner `find` carries the
  enclosing path (`ip,address`); the canonical structure exposes that inner
  command with its resolved path rather than treating `[…]` as an opaque blob.
- **Transport classification — fail-closed.** For each statement, say how it
  would actually run: `api-candidate` (representable as a structured `api`
  operation, with the REST method/path/body), `execute` (script mode,
  expressions, sub-commands), or `unknown` — each with a stated basis. The
  canonicalizer alone cannot *prove* a REST mapping (the syntax-inspection map
  keeps CLI→REST conversion separate from source parsing), so a ready-to-run
  `curl` renders **only** where an explicit, tested mapping rule covers the
  command family; anything else classifies `unknown` rather than promoting a
  heuristic into executable output. The `centrs execute`/`centrs api`
  invocation renders for either classified case.
- **Mutation analysis is separate from the gate.** The execute gate's verdict
  (`mode`, `writeShaped`) is reproduced **unchanged** — a bracketed
  sub-command selector stays `mode: "script"` / `writeShaped: false`, exactly
  as `canonicalizeExecuteCommand` and its anchor tests
  (`test/unit/execute-canonicalize-contract.test.ts`) pin it. Richer
  explain-only inference (an inner `remove` detected in structure) lands in a
  **distinct** field (`structure.containsWrite`, basis `heuristic`) — never by
  widening *or* reinterpreting `writeShaped`, so agents cannot mistake an
  explain inference for a guard `execute` actually applies.
- **Heuristics owned and labeled.** Offline conclusions are canonicalizer
  facts (provenance `canonicalizer`, basis `heuristic`/`derived`) — never
  presented as device or schema truth.

There are real unknowns in how far offline parsing can go (expression
grammar, scope fidelity vs `:parse`, `[]`-nesting corner cases). Grounding
those unknowns is **phase 0** below and gates ratifying this spec.

## Three questions, one pipeline

An agent (the primary caller) asks `explain` three kinds of question before
touching `execute` / `api` / `retrieve`:

1. **Check** — *"is this command right, and how does it run?"*
   `/ip/route add dst-address=10.9.0.0/16 blackhole=yes` → canonical
   `{path, verb, args, mode, writeShaped}`, spans, diagnostics, transport
   classification (+ `curl`/runner rendering on request).
2. **Assist** — *"what can come next?"*
   `/ip/firewall/filter add ch` + cursor → completion candidates with
   provenance, so the caller composes a correct command instead of guessing
   and retrying.
3. **Describe** — *"what exists at this path?"* (live)
   A broad query returns broader, **bounded** results that invite drill-down:
   - `/ip/address` → the verbs available there (with arg counts or a hint to
     name a verb for its args);
   - `/ip/address/set` → the settable arguments;
   - `/ip/address/print` → special-cased to the `.proplist` value set, i.e.
     what the output *can* contain. (The probe recipe this needs — completion
     around a value position — overlaps the upstream `completion-tricks`
     research that is still open; phase 0 must ground it, and the fallback is
     the plainer `child`/`syntax` facts.)

Positions matter more than tokens: the same word can be a verb or an argument
(`/ip/address comment …` is the `comment` *verb*; `/ip/address/add comment=…`
is the `comment` *argument* of `add`), and a probe at a value position (input
ending in `=`) asks for value candidates or type info rather than names. The
canonicalizer resolves the role offline where it can and labels the basis;
live completion is the authority.

Offline, `explain` answers with canonicalizer facts only (structure, gate,
transport shape). Enumerating what a device accepts — verbs, args, enums,
`.proplist` sets — is **live** evidence; a no-router run that would benefit says so
with a tip ("richer data is available if you name a router").

## Evidence modes

| Mode | Trigger | Sources | Provenance label |
| ---- | ------- | ------- | ---------------- |
| **Offline** (default) | no `<router>` given | the centrs canonicalizer only: segmentation, AST-like structure, path/verb/args split, script-vs-structured, write-shape, transport classification, `curl`/runner rendering | `canonicalizer` (basis `heuristic`/`derived`) |
| **Live** | `<router>` given | `request=highlight` (byte-classified spans, first hard error), `:parse` (structure, error line/column), `request=completion` / `syntax` / `child` (candidates, structured help, children/args/`.proplist` sets) | `live-inspect`, stamped with the device's version |

There is **no static schema snapshot** (decision, 2026-07-19): offline mode
does not consult restraml `inspect.json`/`deep-inspect.json` or rosetta data —
version/schema questions are steered to a live router (or to rosetta, by tip).
Offline diagnostics are therefore structural ("this does not parse", "this is
script-shaped"), never existence claims about paths or arguments.

A live target arrives through the **same resolver as every other command**
(CDB name/MAC/group keys, `--quickchr`, future TikTOML — #134/#174): a
target-aware `explain` gets provider targets for free and adds no bespoke
resolution path. Fan-out does not apply — `explain` takes at most one router
and rejects selectors with `usage/fanout-not-supported`, like `terminal`.

Implementation-normative safety rules (evidence in the skill/LSP references):
per-probe timeouts always; skip scripting-keyword paths for `syntax`/
`completion` on versions **before 7.21.4** — the REST-server deadlock is
measured through 7.20.8 and 7.21.4 is the first version proven fixed
(SUP-127641), so the conservative skip covers the untested gap between;
route input past the 32,767-byte highlight cap to `:parse` or report
truncation — never analyze a silent prefix; offsets are **UTF-8 byte** offsets
over ASCII-normalized input and the normalization is recorded; `[]`, timeout,
and transport failure stay distinct outcomes.

One caveat splits the two live cells: **how `:parse` surfaces its error is
transport-specific** (constitution: validation — grounded on CHR 7.23.1).
Only a console transport *prints* the `:parse` result; the native API returns
an opaque `*NN` handle, and the REST/native gate today runs `:parse` without
reading its message. So the line/column diagnostic is guaranteed only where
the transport surfaces the parser text; the native-api cell needs its
degraded readout (or a grounded alternative) specified, with
protocol-specific examples, before it advances past `designed`.

## Surface (Option A — decided)

```bash
centrs explain '<input>' [flags]              # offline
centrs explain <router> '<input>' [flags]     # live — target-first
```

`<input>` is a command, a script fragment (`--file` / stdin for scripts), or a
bare menu path. The positional grammar stays **target-first like every other
router-taking command** (amended in PR review — the shared resolver/selection
helpers assume it): one positional means offline and it *is* the input; two
positionals mean live with the router first; `--` is accepted before the
input; `--file`/stdin replace the input positional in either form. Adding a
router therefore never reinterprets a previously valid offline invocation.
One verb serves all three intents; the accepted risk is that
the refined "broad query → broader results" scheme adds complexity to one
surface rather than splitting into sub-verbs. (Option B — sub-verbs
`explain check|complete|path` — and Option C — folding into the runners — were
considered and set aside; C is rejected outright: the bench grounds a
*separable* cheap tier, offline explain has no runner to ride, and MCP already
serves `centrs_explain` with no CDB.)

**Smart sizing, not depth knobs.** There is no `--depth`. `explain` returns a
*reasonable* amount by default: when more detail is cheap it is included; when
a subtree (paths × verbs × args) is large, it returns **counts plus a warning
that the tree was truncated**, with hints for the narrower query that expands
the interesting part. A single override flag — working name `--full`, final
name TBD — lifts the size limits regardless of result size.

| Flag | Adds | Notes |
| ---- | ---- | ----- |
| *(base)* | canonical structure, spans, diagnostics, transport classification | offline: pure canonicalizer; live: + highlight + `:parse` |
| `--complete [--cursor <byte>]` | continuation candidates at the cursor (default: end of input) | live evidence; offline emits the live-target tip |
| `--schema` | path enumeration: verbs, args, types, enums, `.proplist` | live evidence; offline emits the live-target tip |
| `--curl` | rendered REST call (`curl …`) for `api-candidate` statements covered by a tested mapping rule, plus the equivalent `centrs api`/`centrs execute` invocation | offline-capable; placeholder host + elided credentials when no router is given; `unknown` classifications render no curl |
| `--full` *(name TBD)* | lift smart-sizing limits | — |

Rendering stays separate: `--format`/`--json` remain the settings-vocabulary
output switch. The longer-term wish behind "format levels" — a colorized
breakdown of the command (e.g. unset attributes in grey) — is a **rendering**
concern for the CLI/TUI layer over the same data, not a richness level.

Exit codes follow the `check` pattern: `0` clean, `2` when diagnostics meet
`--fail-on <error|warning|never>` (default `error`), `1` on command failure.

## Result shape (sketch)

Standard envelope (constitution: result envelope); `data` sketch:

```json
{
  "input": { "bytes": 58, "normalized": false, "truncated": false },
  "verdict": "warn",
  "canonical": { "path": "/ip/route", "verb": "add", "args": { "dst-address": "10.9.0.0/16", "blackhole": "yes" }, "mode": "structured", "writeShaped": true },
  "structure": { "statements": 1, "blocks": [], "containsWrite": true, "subcommands": [ { "path": "/ip/address", "verb": "find", "span": { "start": 19, "end": 42 } } ] },
  "transport": { "classification": "api-candidate", "rest": { "method": "PUT", "path": "/rest/ip/route" }, "curl": "curl -u … https://<router>/rest/ip/route …", "centrs": "centrs api <router> …", "ev": "e0" },
  "spans": [ { "start": 0, "end": 9, "class": "path", "ev": "e1" } ],
  "diagnostics": [ { "severity": "warning", "code": "explain/canonicalizer/ambiguous-verb", "span": { "start": 42, "end": 55 }, "message": "…", "ev": "e0" } ],
  "schema": { "path": "/ip/address", "verbs": [ { "name": "set", "argCount": 9 } ], "truncated": false, "ev": "e2" },
  "completion": [ { "value": "chain", "kind": "argument", "ev": "e2" } ],
  "evidence": [
    { "id": "e0", "source": "canonicalizer", "basis": "heuristic", "outcome": "ok" },
    { "id": "e1", "source": "live-inspect", "probe": "highlight", "basis": "direct-response", "outcome": "ok", "routerosVersion": "7.23.1" },
    { "id": "e2", "source": "live-inspect", "probe": "completion", "basis": "direct-response", "outcome": "ok", "routerosVersion": "7.23.1" }
  ],
  "runtimeAcceptance": "not-proven"
}
```

- **Every derived fact keeps provenance via `evidence[]`** — facts reference
  a stable evidence id (`ev`), and the evidence entry carries source
  (`canonicalizer` vs `live-inspect`), probe, basis (direct response vs
  derived vs heuristic), outcome (`ok`/`empty`/`timeout`/`transport-error`),
  and the RouterOS version stamp. A single global version field is *not*
  enough: facts in one result can come from different probes with partial
  failures. The `RouterOsSyntaxEvidence` contract in lsp-routeros-ts
  `docs/syntax-inspection-map.md` is the adaptation source. Resolved target
  identity lives in the envelope's `meta.target` (constitution) — `data`
  grows no competing identity surface.
- **Envelope semantics mirror `check`**: an analysis that ran is `ok: true`
  even when the input is riddled with errors — the diagnostics *are* the
  data, summarized by `data.verdict` (max severity after analysis). Exit
  codes derive from the verdict vs `--fail-on`; `ok: false` is reserved for
  genuine command failure (unresolvable target, usage error, probe transport
  failure). This lets the library and MCP reproduce the same decision without
  a process exit code.
- **Coordinates are contracted, not implied**: probe offsets are UTF-8 byte
  offsets over the *analyzed* (ASCII-normalized) input with `end` exclusive,
  and the normalization map back to the original input is part of the result.
  The library surface additionally provides original-document positions
  (line + UTF-16 character) for LSP consumers; `--cursor <byte>` stays a
  wire-level CLI convenience.
- **Spans use a centrs-owned vocabulary** (decision): raw RouterOS highlight
  classes are not the default surface. The centrs vocabulary must be at least
  as rich as the RouterOS token classes, and centrs maintains the mapping —
  including color mappings derived from the original RouterOS highlight
  colors — so an LSP consuming centrs can reproduce the current RouterOS
  color scheme faithfully. The indirection decouples consumers from
  cross-version drift in the raw classes; raw classes stay available in
  provenance/debug output.
- Diagnostics are slash-namespaced (`explain/<source>/<slug>`), carry byte
  spans (or line/column from `:parse`), and follow the standard error-model
  severity channels.
- `runtimeAcceptance: "not-proven"` is structural, not boilerplate: it is the
  inspect-vs-runtime gap made machine-readable.
- Live-state token classes (disabled/dynamic/inactive object references)
  surface as facts, not errors; severity policy belongs to the caller.

## MCP and library surfaces

- `centrs_explain` today wraps `canonicalizeExecuteCommand` (offline, no CDB —
  the only tool that serves without one). It grows toward this spec
  **following the CLI scheme** (decision): same facets, same envelope-shaped
  data as the CLI's `--json`, optionally a CDB-resolved target for live
  evidence. The no-CDB offline path must survive, and the MCP adapter must
  not widen the structured gate. The current flat `centrs_explain` shape
  (`{ input, mode, path, verb, attributes, queries, writeShaped }`) is
  **superseded** when this lands — a deliberate pre-1.0 breaking change, with
  `commands/mcp/` examples and integration tests updated in the same change;
  no dual-shape compatibility layer is planned.
- Library (sketch): `explainCommand(input, opts)` pure/offline;
  `explainCommand(input, { target, facets })` live. `lsp-routeros-ts` and
  tikbook are the intended external consumers (hover/diagnostics/completion/
  semantic tokens over these calls); an LSP *protocol* surface on centrs
  stays out of scope (#90) — but the export shape is validated against a real
  LSP consumption spike before it hardens (staging phase 5).

## Non-goals

- No LSP server in centrs — the LSP is a consumer the library must support,
  nothing more.
- No execution probes; no state mutation of any kind.
- No fan-out.
- No rosetta/restraml integration for now (decision): no shell-outs, no
  vendored schema/docs artifacts, no version-history facts. Output may tip
  toward rosetta for docs/version questions; revisit only after centrs's
  shape settles and rosetta publishes stable consumable surfaces.
- No promise of enum exhaustiveness or of the upstream `completion-tricks`
  synthetic-probe recipes (still open research in lsp-routeros-ts
  `BACKLOG.md`) — candidates are labeled as observed, not closed sets.

## Definition of done and staging

`designed` on the strength of this README. When implementation starts, offline
examples gate via unit/fixture tests and each live cell advances to
`CHR-passed` only when its `examples.md` entries run green via
`bun run test:integration` (constitution: done definition). Suggested staging
(sequence, not schedule):

0. **Canonicalization grounding lab** — experiments (corpus + CHR
   cross-checks against `:parse`/highlight) that establish what offline
   parsing can actually achieve: expression structure, block/scope
   resolution, sub-command path re-constitution, transport classification
   edge cases. **Ratifying this spec waits on this phase** — its findings are
   expected to refine the surface above.
1. **Offline core** — the grown canonicalizer: structure + gate verdict +
   transport classification + diagnostics (+ `--curl` rendering).
2. **Live probes** — highlight + `:parse` (+ completion/child/syntax facets)
   over rest-api/native-api with the safety rules above, including the
   broad-query describe ladder and smart sizing.
3. **Facet polish** — `--complete`/`--schema` ergonomics, truncation
   counts/hints, `--full`.
4. **Library/LSP alignment** — export shape hardened against a real
   lsp-routeros-ts consumption spike (semantic tokens via the centrs span
   vocabulary + color map).

## Decisions (2026-07-19 round) and remaining opens

Decided this round (details inline above; recorded in #90):

- **Option A** — one verb + facet flags; broad-query ladder
  (path → verbs, path/verb → args, `print` → `.proplist`); complexity of the
  refined scheme is an accepted risk.
- **Smart sizing** over `--depth`; counts + truncation warning for large
  subtrees; `--full` (name TBD) as the only override. `--format` stays a
  rendering switch; colorized command breakdown is a rendering feature.
- **No offline schema snapshot** — offline is the canonicalizer, full stop;
  schema/version truth comes from a live router (steered by tip) and
  docs/version history stays rosetta's domain.
- **No rosetta coupling for now** — at most steering tips; no calls, no
  artifacts, no maintained bindings.
- **centrs-owned span vocabulary** with RouterOS-fidelity color mapping for
  LSP consumers; raw highlight classes are provenance/debug, not the surface.
- **Grow `canonicalizeExecuteCommand`**; rosetta's `canonicalize.ts` is
  reference-only, divergence expected.
- **MCP mirrors the CLI scheme** and result shape.
- **Script-scale explain is in scope** — block/scope analysis and
  sub-command path re-constitution are target canonicalizer capabilities, and
  per-statement transport classification (execute vs api, `curl` rendering)
  is part of the base output.

Amendments from the PR review pass (Codex/CodeRabbit/Copilot on #184, same
round):

- **Positional grammar is target-first** when live (`explain <router>
  '<input>'`); one positional = offline input. Matches every other
  router-taking command and the shared selection helpers.
- **Transport classification is fail-closed** (`api-candidate` / `execute` /
  `unknown`); `curl` renders only from explicit, tested mapping rules.
- **The gate verdict is reproduced verbatim**; explain-only mutation
  inference lives in `structure.containsWrite`, never in `writeShaped`.
- **Per-fact provenance is an `evidence[]` table** with stable ids; target
  identity stays in `meta.target`.
- **Envelope mirrors `check`** (`ok: true` + `data.verdict` for analyzed
  input); coordinate contract (byte offsets, exclusive `end`,
  original-document mapping for LSP) is explicit.
- **`:parse` readout is transport-specific** (constitution): the native-api
  cell needs its degraded readout specified before advancing.
- **MCP shape change is a deliberate pre-1.0 break**, migrated in one change.

Still open (for the next round / the grounding lab):

1. Final flag names (`--full`, `--curl`, facet names) and the smart-sizing
   thresholds (what counts as "cheap", what triggers truncation).
2. The centrs span vocabulary itself: class list, mapping table from RouterOS
   highlight classes (and their colors), and how unknown/new upstream classes
   degrade.
3. Which command families get tested `curl`/REST mapping rules first (curl is
   REST-only — native-api has no curl analogue), plus placeholder-host and
   credential-elision details.
4. The exact question list for the phase-0 grounding lab, and which spec
   claims it must confirm before ratification — now explicitly including the
   `.proplist` probe recipe and the native-api `:parse` readout.
5. Whether the live describe ladder needs result caching per target+version
   (probe cost vs freshness) — likely deferred to implementation evidence.
