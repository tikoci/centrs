# explain

Analyze a RouterOS command **before** anything runs it: canonical form and
structure, LSP-like token spans and diagnostics, how the command would actually
run (`api`-able vs `execute`-required, including a rendered REST/`curl` form),
and — against a live device — what commands, arguments, and values are valid at
a path, with completion-style candidates for building the right command.
`explain` is the "E" of the explain → validate → run split (constitution:
validation): the cheap, safe knowledge tier in front of the runners
(`execute` / `api` / `retrieve`).

Status: offline baseline `coded`; live probes over `rest-api` and `native-api`
`designed`. **`centrs explain '<input>'` runs today**, without a router or CDB.
[`docs/MATRIX.md`](../../docs/MATRIX.md#offline-analysis) tracks these separately;
[#90](https://github.com/tikoci/centrs/issues/90) indexes the remaining tasks.
The spec is ratified on the [phase-0 grounding lab](#phase-0-ratification-185).
The current finish line is [Offline baseline acceptance](#offline-baseline-acceptance),
not completion of the live protocol cells.
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

- **Shared analysis across transports.** The offline result is independently
  useful to libraries, agents, and editors. Its facts can later accompany
  other commands' envelopes, irrespective of their transport; the rich
  analysis is not currently applied as a runner policy gate.
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

Normalized source structure is the foundation for possible configuration
checks. Preserve command order, selectors, source locations, literal/computed
value distinctions, and unknowns; an input fragment does not establish final
device state. Script-variable bindings are not yet an object-reference model
for interfaces, bridges, or other configuration entities. Security advice,
rule collections, and a browser/Monaco inspector are possible consumers, not
new requirements to implement those products during the offline baseline.
quickchr owns the CHR provisioning/test machinery; rosetta supplies docs and
reference knowledge. This direction adds no runtime dependency on either.

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
- **Symbol scopes follow RouterOS scope identity, not brace depth alone.** Names
  are case-sensitive. Control-flow `do={…}` bodies share the enclosing scope,
  but a named-function definition (`:local F do={…}` / `:global F do={…}`)
  starts a closure: outer locals become parameters there, and a global must be
  re-imported inside the body. If the parser cannot establish which body owns a
  binding, it abstains instead of assigning a confident symbol class (Q13).
- **Transport classification — fail-closed.** For each statement, say how it
  would actually run: `api-candidate` (representable as a structured `api`
  operation, with the REST method/path/body), `execute` (script mode,
  expressions, sub-commands), or `unknown` — each with a stated basis. The
  canonicalizer alone cannot *prove* a REST mapping (the syntax-inspection map
  keeps CLI→REST conversion separate from source parsing), so a ready-to-run
  `curl` renders **only** where an explicit, tested mapping rule covers the
  command family; anything else classifies `unknown` rather than promoting a
  heuristic into executable output. The `centrs execute`/`centrs api`
  invocation renders for either classified case. In particular, selector-based
  writes route to `execute`, while selector-less `set` is `unknown` offline:
  without a schema, `/ip/dns set …` (a singleton) and
  `/ip/firewall/filter set …` (an id-bearing table) have the same shape. Live
  evidence may lift the singleton case; offline never guesses it.
- **Mutation analysis is separate from the gate.** The execute gate's verdict
  (`mode`, `writeShaped`) is reproduced **unchanged** — a bracketed
  sub-command selector stays `mode: "script"` / `writeShaped: false`, exactly
  as `canonicalizeExecuteCommand` and its anchor tests
  (`test/unit/execute-canonicalize-contract.test.ts`) pin it. Richer
  explain-only inference (an inner `remove` detected in structure) lands in a
  **distinct** field, `structure.containsWrite` (basis `heuristic`) — never by
  widening *or* reinterpreting `writeShaped`, so agents cannot mistake an
  explain inference for a guard `execute` actually applies. **`containsWrite`
  is three-valued `true | false | unknown`, not a boolean** (Q16, ratified): a
  curated write-verb table covers ~93% of command nodes and is near-immune to
  version drift (~0.07% of nodes per minor version), but ~6–7% of nodes carry a
  write-shaped verb *outside* any small table (`reboot`, `format`, `delete`,
  `reset-configuration`, …), so a two-valued field would have to call
  `/disk format-drive` a non-write. The field therefore **fails closed to
  `unknown`** for any verb it cannot confirm, with a **hard requirement of zero
  false negatives on statically obvious writes** and `unknown` reported
  separately from `false`. Dynamic execution (`:parse`, stored scripts,
  variable/function invocation) is `unknown` by construction.
- **Heuristics owned and labeled.** Offline conclusions are canonicalizer
  facts (provenance `canonicalizer`, basis `heuristic`/`derived`) — never
  presented as device or schema truth.
- **Fail-closed with an `ambiguous` verdict.** Schema-free analysis has a hard
  floor: a statement that is *nothing but a path* (`/ip/route` is a directory,
  `/system/reboot` is a command, and the text is identical) cannot be resolved
  by a text rule alone. The canonicalizer must abstain wherever nothing but the
  text is available to decide — a distinct **`ambiguous`** verdict, separate
  from "unresolved" — rather than guess. Since #210 the baked container floor
  answers this one pair where it can confirm the path, and since #228 the
  published command axis answers it from the other side, so the requirement
  binds on everything *neither* table carries — still most of it; the two
  paragraphs below that scope it are normative, not a footnote. Four
  ratification questions reached this floor independently (Q6 verb/menu
  boundary, Q3 absolute inner paths, Q13 `variable-undefined`, Q14 bare-word
  recovery), so it is a **structural property of schema-free canonicalization**,
  not a per-case wart; the fail-closed rule is promoted to the constitution's
  canonicalizer-ownership section. The measured cost is small: the shipped
  no-schema verb/menu rule scores **99.9%
  precision on decided at ~3% abstention**, and a static snapshot would recover
  only ~2.3pp of that abstention while churning ~9% of tree nodes per minor
  version — which is why **decision 3 (no offline schema snapshot) ratifies
  unchanged**.

  The *container* half of that pair is since decidable. `src/explain/menus.ts`
  (#207) bakes only the menu-vs-command node type — not a schema — and it is
  version-less because the pinned trees show no `dir`↔`cmd` flip across
  7.10.2 → 7.24rc2 or across architectures. So `/ip/route` now resolves as
  `navigation` (#210). The floor is unmoved: the table is deliberately
  incomplete, absence from it decides nothing, and every rule above it still
  refuses rather than guesses.

  The *command* half is what #228 addressed, by adding a second first-order
  source rather than a schema. MikroTik's CLI Reference is generated from the
  definition structs, and measured against the same four pinned trees it has
  **zero navigation-vs-command contradictions** across 968 exactly-matching
  paths, three RouterOS versions and two architectures; all but one of the 102
  published paths absent from every tree carry a `package`/`conditions`/`syscap`
  gate — their own or an ancestor's — that predicts the absence.
  `src/explain/catalog.ts` unions the two with per-entry provenance, which is
  what keeps `menus.ts`'s device-confirmed floor intact rather than diluting it.
  The publication is still not device truth, but as of #285 it is at least
  spelled like the CLI: MikroTik reshaped it from module pages into per-command
  leaf pages whose slug *is* the CLI path, so the definition-module spellings
  (`caps-man/acl/access-list`) are gone and the alias allowlist that recovered
  them is empty — kept, and kept asserted, to refuse the next one loudly. So
  `/system/reboot` now resolves as a `command` at `/system`, and the floor is
  again unmoved — the residual is a path in *neither* table, such as
  `/disk/format-drive`, which 7.23.2 spells `/disk format` and MikroTik does not
  publish at all.

  Discovery is the union of MikroTik's two published inventories, not the
  sitemap alone. A *branching* menu is served as a trailing-slash category URL
  with no `.md` of its own, while that menu's own entry is published at
  `<dir>/<basename>.md` and listed only in `llms.txt` — so sitemap-only
  discovery dropped 256 of 1,070 pages, silently and field-heavily. Generation
  asserts that every category dir still contributes its leaf, so the next
  inventory reshape fails loudly instead of shrinking the table (#285,
  tikoci/rosetta#137).

There are real unknowns in how far offline parsing can go (expression
grammar, scope fidelity vs `:parse`, `[]`-nesting corner cases). Grounding
those unknowns was **phase 0** (#185); its findings are folded in throughout
this spec and summarized in [Phase-0 ratification](#phase-0-ratification-185).

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
     what the output *can* contain. **The probe recipe is grounded** (Q10,
     version-flat 7.23.2/7.24rc2): `completion input="<menu>/print proplist="`
     with rows filtered `show === "true"` yields the property-name set (a
     superset of the keys a `GET` returns). Two device traps are pinned:
     (1) the console word is the dot-free `proplist=` — the REST body key
     `.proplist` returns generic value metadata, not the set; and (2) the rows
     are selected by `show=true`, not by `style` (whose value here is `none`,
     not `arg`). The `child`/`syntax` fallback is needed only for singleton
     settings menus that expose no `.proplist`.

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

There is **no static schema snapshot** (decision, 2026-07-19, amended 2026-08-07
by #228): offline mode makes no call at analysis time — not to a router, not to
rosetta, not to the network — and ships no argument names, types, enums,
per-menu verb lists or `.proplist`. Version and schema questions are steered to
a live router (or to rosetta, by tip). Offline diagnostics are structural
("this does not parse", "this is script-shaped"), never claims about what a
command accepts.

Offline mode does ship two generated **structure** tables, baked at build time
from pinned sources and read as ordinary closed lists. They may say whether a
path is navigation or a command; they never describe what a command accepts.
Absence from either abstains and never rejects. Regenerate with
`bun run explain:menus` / `bun run explain:catalog`; `--check` drift-gates both
in QA. Do not hand-edit them — each file's header carries its source pin and
rationale.

- `src/explain/menus.ts` (#207) — container paths from pinned restraml
  `/console/inspect` trees. **Read today** to confirm navigation, on its own by
  `write.ts` and `symbols.ts` and unioned by `is-known-menu.ts` elsewhere.
- `src/explain/catalog.ts` (#228) — path → kind, per-entry provenance and
  MikroTik's published applicability gate, unioned from those same trees and
  CLI Reference. Its **command axis is read today** by `pathresolve.ts` (R12),
  `verbsplit.ts` and `write.ts`. Since #235 its **menu/settings kind is read
  too**, unioned with `menus.ts` behind one `isKnownMenuPath` helper
  (`src/explain/is-known-menu.ts`): it confirms a relative bare path once the
  inherited context is applied (`filter` or `firewall filter` under `/ip`), and
  it is the same union `verbsplit.ts` consults for an absolute bare path, which
  now reads `/interface/ethernet/poe` as navigation instead of `ambiguous`. An
  unknown joined path abstains and poisons following relative statements. A gate
  never decides anything offline — it explains why a published path may be
  missing from a given router, and no router was consulted to build the table.

`write.ts` deliberately stays on `menus.ts` alone, and that asymmetry is the
safety rule rather than an oversight: a published command misread as a menu
would drop a WRITE as navigation, so a `published`-only entry is decisive for
`command` and only a tie-breaker for `menu`. The #235 union is safe where it is
read because both consumers there answer "where does the context move?", and a
wrong menu costs a path, not a missed write.

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
over ASCII-normalized input and the normalization is recorded (the exact
normalization rule is pinned under [Result shape](#result-shape-sketch), Q15);
`[]`, timeout, and transport failure stay distinct outcomes.

The **native-api `:parse` readout is grounded, and the cell is *not* degraded**
(Q11, version-flat 7.23.2/7.24rc2): `:put [:parse "<input>"]` invoked over the
native API's `/execute` **with `as-string=""`** returns the parser text —
including the `(line N column M)` diagnostic on a syntax error — byte-identical
to what a console transport prints. The opaque `*NN` value seen otherwise is the
**no-`as-string` job handle**, not a `:parse` limitation; the readout rule is
"pass `as-string` and interpret `ret`". The existing execute gate already passes
`as-string` but currently discards `ret`; phase 2 must extract/fix that shared
readout rather than copy the omission. `/console/inspect`
(highlight/syntax/completion) works over the native API's `talk` framing too. So
the line/column diagnostic is available on both live cells — the earlier caveat
that only a console transport surfaces the parser text is retired.

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
input; **`--file` replaces the input positional in either form**, so with it
every positional is a target. Adding a
router therefore never reinterprets a previously valid offline invocation.

**Ambient stdin is read only when no positional could be the input** — that is,
the offline form with nothing else to analyze. A positional always wins, and
when fd 0 is redirected anyway the result carries a
[`usage/stdin-ignored`](../../docs/errors/usage/stdin-ignored.md) warning rather
than quietly dropping the pipe. `--file -` names stdin explicitly; it is the
offline fix today, since the live form it also spells
(`… | centrs explain edge1 --file -`) is parsed and then refused with
`usage/not-implemented` until phase 2. The narrower rule is
deliberate and measured: `runCli` is called in-process by tests, so reading fd 0
on any path a positional invocation reaches consumes the invoking shell's
stdin — it fed those bytes to the analyzer and broke 21 unrelated tests once,
then passed on the next run because the read had drained the fd. Detecting the
collision is a stat on fd 0, never a read, which is why it is reported instead
of resolved.
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
  "input": {
    "bytes": 51,
    "normalized": false,
    "truncated": false,
    "positionMap": [ { "analyzed": { "start": 0, "end": 51 }, "originalUtf16": { "start": 0, "end": 51 } } ]
  },
  "verdict": "pass",
  "canonical": { "path": "/ip/route", "verb": "add", "args": { "dst-address": "10.9.0.0/16", "blackhole": "yes" }, "mode": "structured", "writeShaped": true },
  "structure": {
    "statementCount": 1,
    "statements": [
      {
        "span": { "start": 0, "end": 51 },
        "resolution": "resolved",
        "kind": "command",
        "command": { "path": "/ip/route", "verb": "add", "args": { "dst-address": "10.9.0.0/16", "blackhole": "yes" } },
        "transport": { "classification": "api-candidate", "rest": { "method": "PUT", "path": "/rest/ip/route" }, "curl": "curl -u … https://<router>/rest/ip/route …", "centrs": "centrs api <router> …" },
        "ev": "e0"
      }
    ],
    "blocks": [],
    "containsWrite": true,
    "subcommands": []
  },
  "symbols": { "occurrences": [] },
  "values": { "occurrences": [ { "id": "v0", "span": { "start": 26, "end": 37 }, "tokenSpan": { "start": 14, "end": 37 }, "kind": "attribute", "name": "dst-address", "quoted": false, "facts": { "shapeHints": { "values": ["ip-prefix"], "ev": "e9" } } } ] },
  "spans": [ { "start": 0, "end": 9, "class": "path", "ev": "e0" } ],
  "diagnostics": [],
  "evidence": [
    { "id": "e0", "source": "canonicalizer", "probe": "resolveVerbs", "basis": "heuristic", "outcome": "ok" },
    { "id": "e9", "source": "canonicalizer", "probe": "valueShapeHints", "basis": "heuristic", "outcome": "ok" }
  ],
  "runtimeAcceptance": "not-proven"
}
```

- **The two verdicts are separate.** `data.verdict` is the maximum diagnostic
  severity (`pass` / `warn` / `fail`) and drives `--fail-on` only. Each entry in
  `structure.statements[]` has a canonicalizer `resolution` of `resolved`,
  `ambiguous`, or `unknown`. `ambiguous` means the input has multiple valid
  schema-free readings (for example a bare path may be a menu or a no-argument
  command); `unknown` means analysis cannot safely recover a reading. Neither is
  silently collapsed to a diagnostic severity or to a guessed command. A
  resolved statement also carries `kind: "menu" | "command"`, and the three
  shapes are a **discriminated union**, not four independent optional fields:
  a menu carries `command: { path }` and no verb (navigation names a menu and
  nothing else), a command carries `command: { path, verb }`, and a refusal
  carries `unresolved` and no `command`. Narrowing on `resolution`/`kind` yields
  the fields that exist, which is what the LSP and MCP consumers need from the
  exported types. The library reports the two kinds as *separate
  resolutions* — `src/explain/verbsplit.ts` returns `navigation` (with
  `kind: "menu"`) beside `resolved` (with `kind: "command"`), so `resolved`
  keeps meaning "a verb was decided" for its callers. Phase 1 folds `navigation`
  into this envelope's `resolved` + `kind: "menu"`; the envelope vocabulary here
  is unchanged.
- **Whole-input gate and per-statement analysis stay distinct.** `canonical`
  reproduces the existing execute gate's whole-input fields unchanged, including
  its `mode` and `writeShaped` decision. `structure.statements[]` is the
  addressable rich surface for script-scale input: every statement carries its
  source span, resolution, resolved command when available, transport
  classification, and evidence id. This is where multi-statement scripts and
  partial recovery live; a single top-level transport object cannot represent
  them.
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
  and `input.positionMap[]` maps half-open analyzed-byte runs to half-open
  original UTF-16 runs. Identity runs are retained, so consumers never need a
  separate coordinate contract for normalized and unnormalized input.
  The library surface additionally provides original-document positions
  (line + UTF-16 character) for LSP consumers; `--cursor <byte>` stays a
  wire-level CLI convenience. **The ASCII-normalization is byte-count-preserving**
  (Q15, ratified): each non-ASCII byte is replaced by a single placeholder byte
  one-for-one (a multi-byte character becomes N placeholder bytes, never
  collapsed to one), so an analyzed byte offset **equals** the device's UTF-8 /
  `highlight` byte offset identically and offline spans and highlight spans share
  one coordinate system with no fixup. A reference mapper validated the required
  invariants at 100% over ASCII / BMP / astral-surrogate / combining-mark / tab /
  LF-CRLF / lone-surrogate fixtures: every span in bounds; original↔analyzed
  round-trips at boundaries; slicing the original range yields the intended
  token; `end === len` is the legal end-of-input cursor; a cursor interior to a
  multi-byte character snaps to that character's boundary. centrs does not
  NFC-fold — a combining mark is its own position — and `\r\n` counts as one line
  advance while a lone `\r` is not a line break. The production parser runs on the
  analyzed string directly (it is pure ASCII, so its JS index *is* the byte
  offset) and this mapper converts to original line/UTF-16 positions.
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
  severity channels. **Malformed input carries a defect *region*** (Q14): each
  diagnostic points at the byte span of its defect, and the detectable classes
  are {unbalanced delimiter, unterminated string, invalid escape, invalid sigil,
  invalid unquoted hash, BOM, non-ASCII, over-depth nesting}. **Two classes named
  in the phase-0 draft
  of this list are deliberately deferred** (maintainer decision, #192), because
  each would require offline to assert something it cannot prove:
  - **truncation** — offline cannot distinguish a truncated *complete-looking*
    token from a finished one without a schema, as the `--complete` paragraph
    below already states. What is detectable is the *continuation state*
    (trailing `=`, open delimiter), which is a `--complete` concern reported
    against a live target, not a defect region. Emitting it as a defect would be
    the confident-claim-on-ambiguous-input posture Q14 forbids.
  - **stray mid-token delimiter** — plausible but ungrounded. It needs a probe
    matrix (spellings × positions × accepted-form neighbors) before a detector
    is worth having; the #201 round is the standing evidence that a lexical rule
    curated from intuition produces defects the corpus cannot reach.

  Both remain candidates; re-opening either means grounding it first and
  amending this list. `BOM` and `non-ASCII` are **positional facts, never
  errors** — they record where the byte-count-preserving normalization stood in
  for unreadable bytes, and a renderer must not give them error severity (a
  non-ASCII value such as `name="router-🚀"` is a legal command, and non-ASCII
  occurs in ~12% of the phase-0 corpus). Two hard
  recovery rules follow from the phase-0 mutation suite, both **fail-closed**:
  (a) corruption may only degrade a command to `ambiguous`/`unknown`, **never
  invent a confident one** after a defect region — the same fail-closed floor as
  the canonicalizer's `ambiguous` verdict, and the direct fix for the measured
  case where a stray `;` inside a value splits off a garbage fragment that
  offline would otherwise resolve to a bogus path; (b) a **bare-word-headed
  statement** resolved against document context degrades to `unknown` when the
  context is uncertain (an upstream defect can poison it), because a bare word is
  Q4's cascade residual. Deeply nested delimiters emit an over-depth diagnostic
  rather than recursing (Q17 measured stack-overflow and O(n²) blow-up in a naive
  recursive walker; the product parser bounds depth and scans single-pass).
  Offline `--complete` detects trailing-`=` and open-delimiter continuation but
  cannot distinguish a truncated *complete-looking* token from a finished one
  without a schema — so it surfaces the detectable continuation state and defers
  candidate generation to a live target.
- `runtimeAcceptance: "not-proven"` is structural, not boilerplate: it is the
  inspect-vs-runtime gap made machine-readable.
- Live-state token classes (disabled/dynamic/inactive object references)
  surface as facts, not errors; severity policy belongs to the caller.

### What phase 1 offline actually emits (#202a)

The sketch above is the whole shape, and `examples.md` describes the FINISHED
command — both stay as they are. This table says which parts `src/explain.ts`
ships today, so a reader can tell a decision from an oversight. Every gap closes
by ADDING a field, never by changing one, which is why the examples do not need
to move: an example asserting a field this phase omits is simply not green yet,
and its phase is named below.

| Part | Phase 1 offline |
| ---- | --------------- |
| `input`, `verdict`, `canonical`, `structure`, `diagnostics`, `runtimeAcceptance` | complete |
| `evidence[]` | the **offline subset**: `source` is always `canonicalizer` and there is no RouterOS version stamp |
| `structure.statements[].command` | `path` + `verb`, plus **`args` where the argument list was read** (#202c-1); the ordered token list is `statements[].arguments.tokens` |
| `structure.statements[].transport` | complete for commands: `api-candidate`, `execute`, or fail-closed `unknown`, with an equivalent `centrs` invocation and opt-in `curl` for tested REST mappings (#202c-2). The `basis` names the evidence for the route it chose or refused |
| `symbols.occurrences[]` | Q13 name/span/class plus semantic `role`, result-local `bindingIds`, sigil spelling, and an abstention note where needed; **plus** (#239 S2) `valueId` on declarations/assignments with a literal RHS in the same statement, and `reachingValueIds` + `reachingUnknown` on references (flow-sensitive, branch → set, loop/non-literal → `unknown`, no RHS evaluation) |
| `values.occurrences[]` | result-local value id/span plus three separate fact homes: offline `shapeHints`; live `observedType` and `schemaType` remain absent until phase 2. `kind: "element"` rows are array members, carrying `parent` and, for a keyed member, `name` |
| `spans` | comment runs and resolved variable classes only; **no value shape or type** |
| `schema`, `completion` | absent — live evidence, phase 2 |

- **Per-statement arguments are lexed, and the list is all-or-nothing** (#202c-1,
  `src/explain/args.ts`). The ordered token list with spans is
  `statements[].arguments.tokens` (the phase-0 normal form); `command.args` is
  its derived object view, present only when the list was read. Two different
  outcomes, which a reader must not conflate:
  - **The whole list is refused** — `arguments.read` is `false` with a reason,
    and `command.args` is absent — when a token cannot be delimited or named at
    all: a `[…]`/`(…)`/`$x`/`{…}` value, an escape this phase does not decode, a
    left-hand side that is not a RouterOS name, a token split by a continuation.
    Never partially read, because a dropped argument silently changes what a
    rendered `curl` DOES. Two refusals are not lexical at all, but
    places where centrs's two readers disagree about an **unquoted** value: a
    `'`, which RouterOS treats as an ordinary character and the locked execute
    gate treats as a quote (`comment=it's` is `it's` here and `its` to the
    gate); and a `\f`/`\v`, which the gate splits tokens on (JavaScript `\s`)
    and every explain module does not (ASCII whitespace). The device-correct
    reading is the analysis's in both, but the gate cannot be corrected — so
    phase 1 publishes neither rather than putting two confident values in one
    result. Inside a `"…"` run the two agree and nothing is refused. The
    advisory value-anchor view is intentionally wider only for exact array
    literals: a non-empty `{…}` value or a parenthesized run with a depth-zero
    comma is locatable and hints `array`, while the strict REST view continues
    to refuse the whole list.
  - **A token is read but carries no `value`** — the list still reads. The token
    is delimited and classified; only its literal value is unknowable, as for
    the positional in `:log info "result: $[…]"`. **`value` absent means there
    is no literal value**, whatever the token's kind, so a consumer rendering a
    runnable command reads `value`, never the source `text`, and treats absence
    as not-renderable.

  Measured on the frozen corpus: 40.0% of CRUD-verb commands read, 0 arguments
  dropped against the IL oracle, and 0 contradictions with `canonical.args`
  where both decided. That last one holds *because* of the fail-closed rules
  above, not by accident — a trailing `;`, a `'`, and `\f`/`\v` each
  contradicted until review found them. The `;` case is enforced at the
  composition boundary rather than in the lexer, because segmentation strips the
  delimiter before the lexer ever sees it: where the gate read the whole input
  as `structured` and the single statement's reading differs, the analysis
  abstains.

  What offline still cannot do is NAME a positional operand — RouterOS binds
  `:log info "x"` to `message=x` from its schema, and offline reports the
  located positional instead of inventing the name.
- **Transport is classified per resolved command and fails closed.** Only the
  Q8 rules exercised on CHR 7.23.2 and 7.24rc2 become `api-candidate`;
  script-shaped inputs become `execute`, and untested or ambiguous mappings
  become `unknown` with no runnable REST rendering. Four rules are keyed on a
  literal verb (`add`/`get`/`set`/`remove`) and `print` has its three shapes;
  the fifth was recorded as the RULE `action → POST /rest/<path>/<command>`, so
  every other verb rides it. That rule maps a URL and does **not** claim the
  verb exists — a `catalog.ts` miss narrows the basis string, never the
  classification, because "a MISS says nothing" is that table's contract and
  existence is the phase-2 `/console/inspect` answer. An action operand offline
  cannot NAME (`enable *A`, `monitor 0`) fails closed, since RouterOS binds it
  from per-menu schema. Curl is opt-in and uses placeholders offline. Menus and
  refused readings have no transport because there is no command to classify.
- **`spans` carries what offline can prove.** Comment runs, and the variable
  classes Q13 scored at 100% precision on resolved bindings; an abstention is
  omitted rather than rendered as a guess. The Q12 vocabulary over
  path/verb/argument bytes wants device `highlight` as its oracle. A subset is
  not a claim that the vocabulary is closed.
- **`symbols` is the semantic Q13 projection plus flow-sensitive value refs
  (#239 S2).** Each occurrence carries its source name/span, resolved class
  (or `null` when offline abstains), role (`declaration`, `binding`,
  `assignment`, `reference`, or filter `field`), and result-local binding
  identities. Those identities distinguish shadowed names and connect `:set`/
  reference sites to their declaration; they are stable only within one result.
  When `:onerror` establishes two bindings, the list is ordered outer-scope
  binding first, statement-scope binding second. A declaration/binding/
  assignment with a literal RHS in the same statement carries `valueId`
  pointing at its `values.occurrences[]` row; a reference carries
  `reachingValueIds` (the set of literal ids that may reach it) and
  `reachingUnknown` when the set is incomplete. Linear code is last-write-wins;
  a branch merge is a set; a loop merge or a non-literal RHS (`$x`,
  `[find …]`, an expression) is `unknown` — no RHS evaluation, so a
  `reachingUnknown` reference must not be read as a type assertion. The three
  value facts themselves stay on `values.occurrences[].facts`; symbols only
  *refer* to them. A hyphen always terminates a bare `$name`: `$set-dns` reads
  `$set`, while `$"set-dns"` is the spelling that reaches a hyphenated
  declaration. Braced forms such as `${set-dns}` and `${"set-dns"}` are
  rejected by RouterOS at `{` and resolve no reference. In an expression the
  remaining `-dns` is scanned as subtraction plus its right operand; inside a
  string it is literal text.
- **Evidence is offline-shaped, not the whole contract.** The bullet above says
  an evidence entry carries `source` (`canonicalizer` vs `live-inspect`) and a
  RouterOS version stamp; phase 1 emits neither the live source nor the stamp,
  because no probe ran and there is no device to stamp. `ExplainEvidence` is
  typed to what offline produces rather than pre-declaring variants nothing can
  emit, so phase 2 widens the union and adds the stamp — an addition, not a
  change to what a caller reads today.
- **Value facts are three axes, never one `type` string (#225).** RouterOS
  types values at parse time while `highlight` classes every value byte `none`,
  so type evidence is not a subset of Q12 spans. Each result-local
  `values.occurrences[]` row owns one value span and a `facts` object:
  1. `shapeHints: { values, ev }` is offline and heuristic — a list, because the
     axis admits overlap;
  2. `observedType?: { value, ev }` is what a live parser/IL reading supports;
  3. `schemaType?: { value, ev }` is the argument's declared live-schema type.

  The stable/testing CHR matrix fixes the offline lexicon: `num`, `ip`,
  `ip-prefix`, `ip6`, `ip6-prefix`, `id`, `time`, `array`, `mac`, `bool`, and
  `str` — `op` is deliberately not a member: a deferred `(> …)` abstains
  offline and is reported only as a live `observedType` (#288); quoted literals
  hint only `str`, while malformed and out-of-range address-like controls
  abstain even in named attributes. Most vocabulary borrows RouterOS scripting
  type names (with the explicit `macAddr` schema exception below), so a hint
  must never spell a scripting type the device contradicts: `num` is
  **integer-only**, since RouterOS numbers are integers and a dotted decimal is
  an IPv4 shortcut — bare `2.2` is observed as `ip` (`2.0.0.2`), so it hints
  `ip` alone. On that grounded lexicon each spelling reaches at most one shape.
  Colon-form time accepts RouterOS's displayed H:M / H:M:S spelling plus
  week/day prefixes and fractional tails; `00:11:22` is therefore `time`, not a
  short MAC. `mac` deliberately names the CLI Reference `macAddr` schema
  spelling rather than a scripting type: a full six-octet MAC hints `mac` while
  scalar `:typeof` reports `str`. `*1` hints the documented `id` type. A single
  non-time colon is not an address attempt — `comment=foo:bar` hints `str` —
  while malformed multi-colon runs stay fail-closed.

  Arrays are the one structured literal admitted by offline hint anchoring.
  Non-empty `{…}` values and parenthesized expressions with a depth-zero comma
  hint `array`; grouping `(1)`, empty groups, and scope braces do not. The
  strict REST argument reader still refuses every structured value. RouterOS
  has no empty-array literal (`{}` is a syntax error); `[:toarray ""]` produces
  an empty array, but remains an expression and therefore an offline
  abstention. Indexing that empty array produces `nothing`. `.` remains an
  expression operator rather than part of a literal: it produces `str` for
  `1 . 2`, but distributes over arrays in either operand order, so offline
  abstains on the whole concat expression and leaves its result type to #236.
  `[:parse "…"]` similarly produces the observed but undocumented `code` type,
  and `[:nothing]` produces `nil`; neither has a standalone literal spelling,
  so neither becomes an offline shape member. `(> …)` deferred expressions
  are the same case with a different outcome: `(>[:return 1])` is `op` and
  `(>{"a"=1})` is `array` at runtime, but both lower to `(> …)` with arity
  1 and identical `:parse` IL — only `:typeof` distinguishes them
  (`test/fixtures/explain/operators.json` → `sweep.runtime`
  `typeof-deferred`/`deferred-array-typeof` and `sweep.opAxis` `defer-*` on
  7.21.5, 7.23.3, 7.24rc4). Offline abstains on every such form; `op` lives
  only as a live `observedType` (#288, a bounded #225 decision).
  Shape remains non-authoritative: `100000w` is time-shaped but observed as
  `str`. Argument context remains separate: on 7.23.3 and 7.24rc3, both
  `/ip/address address=2.2` and firewall `src-address=2.2` canonicalize it to
  `2.0.0.2`, while `comment=2.2` stays text, netwatch `interval=2.2`
  normalizes to `00:00:02.200`, a boolean slot rejects it, and `:parse` still
  accepts `src-address=not-an-ip`. Boolean grounding has the same separation:
  bare `true`/`false` and `yes`/`no` are scalar `bool`, while their quoted forms
  are `str`; a CLI `disabled=` slot accepts bare or quoted `yes`/`no` but rejects
  `true`/`false`, while REST accepts JSON booleans and the string forms
  `yes`/`no`/`true`/`false`. `:tobool` conversion is a separate runtime operation
  and does not widen the hint. Thus a hint never validates a value or becomes a
  diagnostic, and never changes `runtimeAcceptance`. Quoting likewise never
  earns a wrong-type diagnostic: commands may cast quoted strings at runtime.
  Offline emits only `shapeHints`; phase 2 adds the two live facts into their
  existing homes when its safe IL/schema producers land.

  **A located array is read member by member (#225 V1).** Each member of a
  `{…}`/`(…)` literal is its own `values.occurrences[]` row with `kind:
  "element"`, its own span and hints, a `parent` naming the container's
  result-local id, and `name` when the brace form spells a key. The separator is
  the delimiter's and not a choice: a brace splits on `;` while a depth-zero `,`
  inside one builds a nested array (`{1,2}` is a ONE-member array whose member
  is `(, 1 2)`), a paren splits on `,`, and `(1;2)` does not parse.

  **`=` does three different things inside a literal, and a byte of whitespace
  picks between them (#258).** It binds a key only in the brace form, and only
  where the NAME TOUCHES the sign: `{a=1}` is the key `a`, but `{a =1}` lowers
  to `(= $a 1)` and `(a=1,b=2)` is two comparisons, so keys are read in braces
  only. A key whose right side is EMPTY is not an empty-valued key — the device
  drops the sign and keeps the name as a POSITIONAL `str`, so `{a=}` is the
  one-member array `a`, `{"a b"=}` decodes to `a b`, and `{1.1=}` is the string
  `1.1` rather than the address (no member lexicon runs on a name). Everywhere
  else the sign compares, which returns `bool` whatever it compares, so
  `{$a=1}`, `{(a)=1}`, `{[:timestamp]=1}` and `{{1;2}=1}` are each one `bool`
  member. Every key is a `str` however it is spelled: `{1=1}` keys on the string
  `1`, and `{1.1=1.1}` keys on `1.1` while its VALUE goes through the address
  shortcut to `1.0.0.1`.

  **A member key's name is not the identifier grammar**, and was swept
  character by character rather than borrowed. `.`, `-` and `/` are ordinary
  name bytes anywhere in it, including alone and repeated — `{.id=1}`,
  `{..id=1}`, `{.=1}`, `{-=1}`, `{--=1}`, `{/=1}`, `{a/b=1}` and `{-.1=1}` each
  bind the key spelled exactly that way — while `_` does NOT, even though
  `$a_b` is a good variable: `{_a=1}` and `{a_b=1}` lower to comparisons.
  Neither do `: * ~ % > < + ! @ #`. `@` is stronger still — not a member
  character at ANY position, so `{a@b}`, `{@a}`, `{1;a@b}` and `(a@b,2)` are
  withdrawn outright, though the same bytes are fine one slot out
  (`:local z a@b` parses) or inside quotes (`{"a@b"}`).

  `bool` is claimed only where the `=` is the member's TOP operator, which
  offline reads as a left side that is one complete operand — a name, `$name`,
  or a fully-enclosing `(…)`/`[…]`/`{…}`. `{a b=1}` lowers to `(  $a (= $b 1))`
  and `{$a=1,2}` to `(, (= $a 1) 2)`; in both the sign is nested under an
  operator whose type is its operands', so both abstain. That operand class is
  **narrower than RouterOS's**, deliberately: `{a_b=1}`, `{:a=1}`, `{1+1=2}`
  and `{$a/b=1}` are `bool` on the device and silent here, because widening it
  means first proving the `=` stays on top for the new spelling. Operand
  position is also stricter than KEY position — `{a-=1}` binds the key `a-`
  while `{a- =1}` does not parse at all — so both classes end on an
  alphanumeric there.

  An empty side is a
  syntax error in every spelling asked — `{=}`, `{=1}`, `(=1,2)`, `{$a=}`,
  `{(a)=}`, `{a =}`, `{a b=}`, `{a,b=}`, `{[:len 1]=}`, `{{1;2}=}`, `{1+1=}`,
  `{a<=}`, `{a==}`, `(a=,2)` — so it withdraws the literal rather than
  abstaining on the member. That withdrawal needs POSITIVE evidence that the
  left side is an expression (a byte no key may hold — `NOT_IN_MEMBER_NAME` in
  `src/explain/args.ts`, the complement of `MEMBER_NAME`), never the key
  reader's silence: a name spelling this phase does not recognize abstains
  instead, so the next `.id` costs a dropped member rather than a withdrawn
  literal.

  **Two member faults have nothing to do with `=` and are checked before it.**
  A `$` takes an alphanumeric or a quote and nothing else — `$"a b"` is a good
  variable name while `$.id`, `$_a`, `$:a`, `$/a`, `$$a`, `$(x)` and a bare `$`
  are syntax errors — and no run may END on a dangling operator: `{-}`, `{--}`,
  `{a-}`, `{$a-}` and `{$a.}` are refused, though `{a.}`, `{.}`, `{/}` and
  `{a/}` parse, because a bare name absorbs a trailing dot and a `$` name does
  not. Both hold anywhere in a member, and both reach the `=` axis only through
  a left operand (`{a- =1}`, `{$a-=1}`, `{$.id=1}`). The 186
  rows are in
  `test/fixtures/explain/values.json` → `interiorGrounding.keyBinding`, and the
  value census below is unchanged by all of it — no statement in the 948-script
  corpus reaches any of these branches, so the fixture is the only falsifier
  they have.

  **A member is not an argument value, because the device does not parse it as
  one.** Inside a literal RouterOS reads an expression, so the member lexicon is
  its own: a bare word is a variable reference (`{abc}` lowers to `$abc`), and
  so is a full MAC (`{00:11:22:33:44:55}`) and any time literal past the signed
  64-bit nanosecond range, whose cliff sits between `15250w` and `15251w`,
  `106751d` and `106752d`, `9223372036s` and `9223372037s`. `*1` does not parse
  at all there, though `:local x *1` is `id`. Hexadecimal is added — `0x10` is
  16, while `0X10` is a variable — and `str`-by-fallback, `mac` and `id` are
  dropped. Everything else abstains: expressions, substitutions, `$x`, and the
  dotted-decimal-to-seconds fallback described below.

  **A `{…}` array literal is legal only in a root scripting directive's value
  slot, and only in a slot the device proved.** `/console/inspect` classes the
  `{` byte `error` and `:parse` refuses the statement for
  `/ip/route/add comment={1;2}`, `/ip/dns/set servers={1.1.1.1;8.8.8.8}` — a
  LIST-typed attribute, which is what rules out a schema-shaped reading —
  `/interface/print .proplist={name;comment}`,
  `/ip/route/print where comment={1;2}`, the relative spelling
  `ip route add comment={1;2}`, and `:log info message={1;2}`; while
  `:local z {1;2}`, `:put {1;2}`, `:len {1;2}` and `:foreach i in={1;2}` all
  parse.

  Being a directive is necessary but not sufficient, and the path does not
  decide: `:delay {1;2}`, `:beep {1;2}`, `:resolve {1;2}`,
  `:if condition={1;2}` and `:local name={1;2}` are syntax errors at a `/` path
  too. The gate is keyed on **(verb, slot)** from a device sweep of every root
  builtin and every slot it completes — 222 rows in
  `test/fixtures/explain/values.json` → `interiorGrounding.braceSlots`, baked
  into `src/explain/brace-slots.ts` — and a slot has four outcomes, not two:

  | outcome | what the slot does with `{(1,2)}` | example |
  | ------- | --------------------------------- | ------- |
  | `array` | evaluates it — IL `(, 1 2)` | `:local z`, `:put`, `:foreach in=`, `:for from=` |
  | `code` | runs it as a program | `:onerror in=`, `:retry command=`, `:if do=` |
  | `text` | keeps it verbatim as a script | `:execute script=`, `:grep script=` |
  | `error` | refuses the statement | `:delay`, `:beep`, `:local name=` |

  Only `array` slots are read as arrays; the other three and the 30 rows the
  sweep could not ask are refused, which costs coverage and never correctness.
  A positional is keyed by its index, because position decides — `:local {1;2}`
  puts the literal in the NAME slot and does not parse, while `:local z {1;2}`
  puts it in the VALUE slot and does. `{1;2}` alone cannot build this table:
  `:local z {1;2}` and `:execute script={1;2}` both lower to `…=1;2`, so the
  array test has to be a literal whose evaluated and verbatim readings differ. The `(…)` spelling is never rejected at the delimiter in any of those
  positions — `.proplist=(name,comment)` still draws `bad parameter .proplist`,
  but that is a name-level diagnostic and the plain `name,comment` spelling
  draws it too — and a `(…)` or `[…]` around a brace restores the expression
  context. The braces a
  command argument does take are script bodies (`source=`, `on-event=`), and
  those are not arrays either — they are refused earlier as scope blocks. A
  top-level brace value in any other command argument emits
  `explain/canonicalizer/invalid-command-brace` at the `{`; parentheses or a
  `[…]` substitution restore the expression context where the same literal is
  legal. An empty member is a
  syntax error (`{;}`, `{;1}`, `{1;;2}`, `(1,)`) and withdraws the enclosing
  `array` shape with it; a single trailing separator is legal in the brace form
  only (`{1;}` and `{1;2;}` parse, `{1;2,}` and `{2,}` do not).

  **A nested member the device rejects withdraws its container too.** A `(…)`
  inside a literal is a GROUP as often as an array — `{(1)}` is the one-member
  array `1` — so an empty group (`{()}`, `{a=()}`) and an empty comma member
  (`{(1,)}`, `{(,)}`, `{1;(2,)}`, `(1,(2,))`) are named as faults rather than
  abstained on: `:parse` rejects each of them at every nesting depth, while
  `{(1)}`, `{a=(1)}` and `{1;(2)}` parse. `highlight` is not the oracle for this
  family — it accepts `{1;2,}`, `{2,}` and `{(1,2),}`, all of which `:parse`
  rejects. Member descent stops after eight frames, and the bound WITHDRAWS
  rather than keeping an unverified shape: a fault below it still makes the
  whole statement a syntax error — `:parse` rejects a `(1,)` buried nine levels
  deep exactly as it rejects a shallow one — so a literal nested deeper than
  eight is refused instead of called an array. The deepest member in the
  948-script corpus sits at depth 6.

  **The bare comma spelling is the one place a hint is genuinely plural.**
  `=1,2,3` is not a syntax error anywhere, and whether the device SPLITS it is
  decided by the argument's type, which offline does not have:
  `servers=1.1.1.1,8.8.8.8` lowers to `servers=1.1.1.1;8.8.8.8` and
  `dst-port=80,443` to `dst-port=;80;443`, while `comment=a,b` and
  `interface=ether1,ether2` keep the whole run as one string. A named attribute
  therefore carries `["array", "str"]` — both readings, neither validated. In an
  expression position there is no second reading (`:local x 1,2` is a
  two-member `array`, and so is `a,b`), so the hint is singular there. No
  members are located for a bare comma run: whether it splits at all is the
  schema's answer, and a member span would be a guess. The `(1,2)` spelling,
  where the delimiters prove it, is anchored and descended into as usual.

  The short IPv4 spelling fills the LOW octets and every field is one octet:
  `1.255` is `1.0.0.255` but `1.256` is `time` `00:00:01.256`, `1.16777215` is
  `time` and not `1.255.255.255`, and `1.1.256` is plain text. Offline abstains
  on the seconds fallback rather than encoding a chain that depends on a failed
  address attempt.

  <!-- BEGIN GENERATED value-census — regenerate with `bun run explain:value-census:readme` -->
  The corpus census is re-derivable with `bun run explain:value-census` and
  covers 948 source scripts. The figures below are generated from
  `test/fixtures/explain/values.json` → `corpus` by
  `bun run explain:value-census:readme` and gated against it by
  `bun run explain:value-census:readme:check`; the fixture itself is gated
  against a fresh corpus run by `bun run explain:value-census:check`. Of the
  13,161 emitted values in a statement the strict argument lexer ALSO read, 0
  disagree with it on half-open byte span or decoded text, while the
  prefix-safe scan retains a further 6,538 values across 568 statements whose
  strict REST reading abstains. Of 19,699 emitted occurrences, 5,636 are array
  members (529 keyed, 1,147 nested inside another member) and 808 are arrays;
  the corpus holds no source-literal `id` example. The three structural
  counters — spans addressing bytes outside their own source, members naming a
  container that does not exist, members escaping the container they name —
  read 0, 0 and 0, and each must stay 0.
  <!-- END GENERATED value-census -->

  The strict lexer remains all-or-nothing; only non-authoritative hints use the
  wider view.

### Offline comment placement (#245)

Comment recognition is contextual, not a rule that every unquoted `#` begins a
comment. The shared offline walkers follow this table, grounded with
`/console/inspect request=highlight`, `:parse` IL, and `:typeof` on CHR 7.23.3
(stable) and 7.24rc3 (testing):

This intentionally follows the live parser rather than the scripting manual's
broader prose that a `#` starts a comment. The same live probes distinguish a
comment, a literal hash value, and a hard error at the exact byte.

| Position | Device reading | Offline rule |
| -------- | -------------- | ------------ |
| Statement-leading at the document root, after a real statement separator, in a `do`/`else`/`foreach do` body, or immediately inside a `[…]` command substitution | `comment` through newline | Mask it and preserve byte offsets. A command first consumes that lead, so `[:put #test]` keeps `#test` as the value. |
| First non-space content inside a stored-script brace such as `on-event={ # c` | `comment` | Treat exact `source`/`script` and `on-*`-named brace values as comment-bearing script bodies; a suffix such as `myScript` is not one. |
| Immediate line start after `\` + newline | `comment`; the pending statement survives | Mask it in both argument views; the continuation-reach rules remain H5/#215. |
| Inside an array (`{#test}`, `{1;#test}`, `{a=1;#b=2}`) or parenthesized expression (`(1,#test)`) | hard `error` at `#`; `:parse` reports `syntax error` | Do not mask it or emit an array value hint; semantic resolution stops there. |
| A scope-named brace (`do=`/`else=`/`command=`/`script=`/`source=`/`on-*=`) nested inside an array (`:local z {do={ # c⏎:put 1}}`, `:local z {script={ # c⏎…}}`, `:local z { { # c…}}`) — and likewise a bare `{` or `/menu {` inside an array | hard `error` at `#`; `/console/inspect` request `highlight` classes that byte `error` on CHR 7.23.3 (grounded in #249 on the four `#249` rows plus `bare {`/`source`/`on-event` corners) | A brace bears statements only when its enclosing context already does — `enclosing && braceStartsStatements(…)` on each walker's stack (`contexts`/`delimStack`/`frames`/`stack`). Inside an array the name is an array key and its `{…}` is a nested array. A `[…]` substitution nested in that array does re-enter a statement context, so `[:do { # c…}]` stays a real comment and a bare `{` under a bracket does too. |
| Inside a `[…]` substitution that is itself nested in an array (`{[:put #test]}`, `{1;[:put #test]}`) | literal value (`none`) — the bracket restores the statement role the array dropped | Keep it as content and keep the enclosing array readable. The role is per frame, so an array or group opened again inside that bracket (`{[:put {#test}]}`, `{[:put (1,#test)]}`) is `error` once more; skipping whole `[…]` regions would wrongly accept those. |
| In an attribute or bare value (`comment=#test`, `comment=a#b`, `:global y #test`) | literal value (`none` highlight class) | Keep it as content. |
| Inside a quoted run | string content | Keep it as content. |
| After a closing scope brace (`} # c`) | hard `error` at `#` | Do not mask it. |
| After a complete fixed-arity scripting directive (`:local x 2 #`, `:set x 3 #`, `:put 2 #`) | hard `error` at `#`; `:parse` reports `expected end of command` | Emit `explain/canonicalizer/invalid-hash` at the first such byte and fail closed after it. A hash in the still-open value slot (`:local x #test`, `:set x #test`, `:put #test`) remains content. |

An otherwise unrecognized `name={…}` is structurally an expression/array, not
a stored-script body. Whether the target command's schema accepts an array at
that argument is a separate live schema/runtime question; comment classification
does not imply type acceptance.

This distinction is why brace role lives in one shared primitive below the
segmenter, block reader, and symbol resolver. The `#249` widening adds the
single conjunct `enclosing && braceStartsStatements(…)` at the four walker
sites so a scope-named or bare brace inside an array is another array.
The strict argument lexer now uses the same comment-masked structural view as value anchoring, so a continuation
comment cannot fabricate positional operands or downgrade a tested REST shape.
The 948-script corpus contains no such continuation-comment argument case. The same holds for #249:
the corpus re-measurement below shows no readable/abstention movement — no
`do=`/`else=`/`command=`/`script=` brace sits inside an array in the 948
scripts, so the fix closes a device-grounded false `pass` with zero corpus
blast radius. The readable set stayed exactly 7,385 statements. Recognizing a bracket-leading hash
as a comment conservatively folds two previously separate abstentions inside
one foreign kernel-panic transcript (`[#1]` / `[#2]`) into its already-unknown
outer statement, leaving 14,329 argument-bearing candidates and 6,944
abstentions (48.4612%). That two-statement movement is a blast-radius
measurement, not the grounding evidence; the two CHR versions above are the
oracle. (Those are the #249-era figures; the #285 catalog correction has since
moved the readable set to 7,392 — see the re-measurement below.)

The same corpus run finds five new `invalid-hash` diagnostics, all in pasted
non-RouterOS material: one NGINX server block, one JavaScript highlighter, one
JSON-like transcript, and two shell-shaped snippets. No RouterOS command reading
moved; these diagnostics say those bytes are not valid RouterOS, not that the
foreign snippets were expected to parse as RouterOS.

The default text renderer surfaces comment spans in a `comments:` section; JSON
continues to carry the same ranges as `spans[]` entries with `class: "comment"`.

Corpus re-measurement for #249 — `bun -e 'explainCommand'` over the 948-script
`lsp-routeros-ts/test-data/corpus.sqlite` (same harness as § *What `offline` actually emits*):

- `stmts` 18,648 · `argCandidates` 14,329 · `argReadable` 7,385 · `abstentions`
  6,944 (48.4612%) — **identical** before and after the `enclosing &&`
  conjunct (stashed vs patched, verified by `git stash --keep-index`).
- `invalid-hash` diagnostics: 5 files / 5 diagnostics both before and after —
  the widening has no corpus hit, because the corpus contains no `do=`/`else=`/
  `command=`/`script=` brace nested in an array. Zero blast radius is the
  expected outcome; the grounding remains the 15-input CHR probe below
  (CHR 7.23.3 `highlight` at the `#` byte, 0/15 mismatches), not a corpus delta.

The #285 catalog correction moved those figures, and only upward. Same harness,
old table vs new:

| | #249 | #285 |
| --- | ---: | ---: |
| `stmts` | 18,648 | 18,648 |
| `argCandidates` | 14,329 | **14,336** |
| `argReadable` | 7,385 | **7,392** |
| `abstentions` | 6,944 | 6,944 (**48.4375%**) |
| `ambiguous-statement` | 91 | **85** |
| `unresolved-statement` | 3,911 | **3,910** |
| `context-lost` | 69 | **83** |

Six scripts move, and every statement in them is a correction. Seven statements
that read as `ambiguous`/`unknown` now resolve and their arguments read —
`/interface/monitor-traffic`, `/system/package/apply-changes`,
`/system/package/update/{check-for-updates,download,install}` — which is the
whole of the `argCandidates`/`argReadable` gain, with `abstentions` flat. Five
more read the same but with the right verb: `/ip hotspot user reset-counters
[find …]` took `hotspot` as the verb and now takes `reset-counters`, which also
reclassifies it as a write. No document changes `containsWrite` verdict.

`context-lost` rising is the resolver **withdrawing** a certainty claim, not
losing ground. It is `info` severity and marks a statement that resolved
correctly while the document context was already unknown. All 14 are in one
script — a bare list of command paths, one per line, with no navigation
anywhere. Previously `/interface/monitor-traffic` was unreadable and so *might*
have been an absolute navigation, which R4 has REPLACE the context; certainty
was restored on that maybe. Knowing it is a command, the resolver knows it never
navigated, so the context stays as unknown as it already was.

- **Severity is fixed here, because it drives `--fail-on`.** Three buckets, and
  the split is not "structural vs not":
  - `error` — `unclosed`, `unbalanced-close`, `unterminated-string`,
    `bad-escape` (code-position `\` + non-whitespace), `bad-string-escape`
    (string-internal unknown/lowercase-hex/truncated — CHR `highlight` `error`
      `:parse` `expected message value`, grounded stable+testing #247),
    `bad-sigil`,
    `invalid-hash`, `missing-statement-separator` (#311, below). Eight classes
    the device itself rejects.
  - `warning` — `over-depth`, because it is centrs's own resource bound and says
    nothing about whether the input is legal; and an `ambiguous`/`unknown`
    resolution, never an error, so the default `--fail-on error` cannot fail a
    document whose only sin is being unreadable without a schema — which is most
    of RouterOS scripting.
  - `info` — `bom`/`non-ascii` (positional facts: a legal command must not
    fail), and `context-lost`, which reports a reading that is correct while the
    document's menu context was already gone.

### The missing statement separator (#311)

Two commands written with no `;` or newline between them used to read as one
command with extra operands, and offline reported `pass`: `/ip/address add
interface=ether1 /ip/route add gateway=192.168.88.1` published `gateway` as an
attribute of `/ip/address add`. The rule that closes it is a known **menu path**
in operand position followed by a console **verb** — never "a `/` after the
verb", because a slash-shaped operand is legal and `/file remove
/flash/skins/foo.html` lowers cleanly to `numbers=/flash/skins/foo.html`. The
menu spelling may be slashed, spaced, or mixed (Q3 R4); the device rejects
`/ip route add` exactly as it rejects `/ip/route add`.

**The device evidence is not what the report said, and the correction widened
the rule.** #311 gave the error byte as the `=` of the trailing attribute
(`expected end of command (line 1 column 55)`). That byte is an artefact of that
head: `add` abbreviates `/ip/address/add`'s own `address=` argument, so the
console reads `add gateway` as `address=gateway` and only complains at the `=`
after it. Change the head so the second verb abbreviates nothing and the answer
changes shape — `/system/note set note=hello /ip/route add gateway=1.2.3.4` is
no hard reject at all; `:parse` returns IL carrying `bad parameter /ip/route
(line 1 column 38)`, naming the second **path**. Both are refusals, and which
one appears depends on per-menu argument names, which offline does not have. So
the grounded claim is the negative one: across every probed spelling on CHR
7.24.2 and 7.23.5, RouterOS answers `bad parameter <path>` or `expected end of
command`, and never accepts the shape. A trailing attribute is therefore **not**
required, which #311's own example had made it look like.

The head-dependence goes one step further than "which wording", and it bounds
what the diagnostic may say. On a head whose own value slot takes a bare
positional, the second path is absorbed into that slot and the device refuses
the **verb** instead: `:put /ip/route print` lowers to `/putmessage=/ip/route`
and answers `bad parameter print`, and `:local a /ip/route add` lowers to
`/localname=$a;value=/ip/route` and answers `bad parameter add`. Both are still
refusals — `/system/script/run /ip/route`, the same shape with no verb after
the path, lowers cleanly to `number=/ip/route` — so the offline `error` stands.
But the message says the bytes **read as** a second command, which is centrs's
heuristic reading, and never that the device starts one there or which token it
will name. Every row above is pinned in
`test/integration/explain-separator.test.ts`.

**The contradicted reading is withdrawn, not patched.** The statement stays
`resolved` — `/ip/address add` really is the head, and `highlight` agrees. What
is withdrawn is withdrawn by three separate gates, each with its own trigger:

1. **The argument list.** `withoutSeparatedArguments` drops `command.args` and
   sets `arguments.read` to `false`. This is the same all-or-nothing move
   `enforceGateParity` makes for a gate/analysis disagreement, but it is a
   distinct gate on a distinct trigger — the two never consult each other. The
   device says the move is right rather than merely cautious:
   `… /ip/route add placeholder` lowers to
   `address=placeholder;;interface=ether1`, a phantom attribute the source never
   wrote, because the second run's words can abbreviate the HEAD's argument
   names.
2. **The invocation.** `rejectedBySeparator(runs)` sets the new
   `ExplainTransportInput.rejected`, which `classifyExplainTransport` honours
   ahead of every mapping rule and answers `unknown`. Without it the degraded
   `arguments` would fall through to `execute` and print a ready-to-paste
   `centrs execute '<router>' '<the malformed text>'` for bytes the same result
   calls a syntax error. **Unread is not rejected** — an unread argument list
   still legitimately rides the raw CLI surface, and that path is unchanged.
3. **The value facts from the run onward.** `values.occurrences` is an axis of
   its own, not a projection of `arguments` — the value census above pins how
   many values it retains in statements whose strict REST reading abstains — so
   gate 1 does not reach it and a cut is needed. The cut is the run's first byte, and
   the device draws the line in the same place: `:parse` reads `gateway` as the
   VALUE of `/ip/address/add`'s own `address=`, never as an attribute NAME,
   while the head's `interface=ether1` survives into the IL (as `note=hello`
   does in the `/system/note set` row). Values before the cut therefore stay;
   values reaching into or past it are dropped, and with them the `value` token
   class over those bytes.

**Abstentions, stated.** A menu path with no verb after it (`… /ip/route`) and a
bare operand a menu does not accept (`… placeholder`, `/file remove a b`) also draw
`bad parameter`, but that is the generic "no such positional" complaint;
deciding it needs the per-menu positional list, which `catalog.ts` deliberately
is not, and a separator is not necessarily the fix. Both abstain. The shape
filter over a candidate path does admit a leading digit, because
`/interface/6to4` is a real menu in both structure tables; presence in those
tables, never the filter, is what decides. Over the 948-script pinned corpus the
rule fires **0 times**, so no published census figure moves; the 38 corpus
scripts the device answers `expected end of command` for are all other causes
(line continuations, `<tab>`/`<VALUE>` placeholders, pasted shell and Python,
stray parens), which is #203's genre bias showing.

**The reach limit is closed (#316).** This rule used to read
`statement.arguments.tokens`, the all-or-nothing strict reading, so a statement
holding a variable carried no tokens and the run in it was missed:
`/ip/address add interface=ether1 /ip/route add gateway=$g` reported `pass`
where its literal twin reported the separator. It now reads the skip-tolerant
token stream described below, and both spellings report the separator — as does
`/ip/address add interface=$x /ip/route add gateway=1.1.1.1`, where the
undecodable token comes FIRST and a prefix-only reading would still have missed
it. The corpus count is unchanged at **0** for the same reason it always was
(#203's genre bias), so this buys reach rather than a number. What still stops
the rule is an unterminated string or an unbalanced delimiter, because neither
walk can find a boundary to resume from.

### The token stream a rule reads (#316)

`lexArguments` is all-or-nothing by design: its consumer renders a runnable REST
request, and a partially-read argument list changes what the rendered command
DOES. That is the right reading for a renderer and the wrong one for a rule —
the first token it declines discards every token already decoded, which put
**48.2%** of the corpus's argument-bearing statements out of reach of every
token-level rule and of the `arg` token fill.

`lexArgumentTokens` is a third reading over the same walk — alongside strict
`lexArguments` and the prefix-safe `lexValueAnchors` values already use. Same
text, same `from`, the same boundary rules and the same refusal strings,
differing only in what a refusal does. Where the strict reading discards the list, this one publishes the token
it could not decode with its bytes located, `undecided` set to that same reason
and **no `value`**, then carries on to the next token. `statement.arguments` is
unchanged and still strict; nothing that renders a command gained reach.

**Skip-and-continue, measured against stop-at-first-refusal.** #316 named two
designs and said the fork was load-bearing rather than cosmetic. It is. Both are
priced by `bun run explain:arg-reach` over the 948-script pinned corpus, from
one implementation — design A is the tolerant token list truncated at its first
`undecided` token, which is exactly the prefix the strict walk discards:

| | strict | A — prefix | B — skip |
| --- | ---: | ---: | ---: |
| statements reached, of 14,267 | 7,385 (51.8%) | 10,754 (75.4%) | 14,267 (100.0%) |
| argument tokens | 16,652 | 20,481 | 31,310 |
| missing-separator runs found | 0 | 0 | 0 |

A further 58 statements sit outside every column because their bytes are not
addressable (normalized, or a span widened to the enclosing statement); the
sweep counts them rather than dropping them silently, since `explain.ts` refuses
those too and lexing them here would measure a reading the product does not
offer.

A recovers 3,369 statements; the 3,513 statements whose FIRST interesting token
is the undecodable one have an empty prefix and are reached only by B — so the
cheaper design leaves slightly more behind than it recovers. The separator row
is 0 across all three and is reported rather than buried: on this corpus neither
design finds a run the strict reading missed, which is what #203's genre bias
predicts for a typo class published scripts do not carry. The sweep also asserts
what makes the A column trustworthy — that the strict tokens are the tolerant
walk's prefix byte for byte, and that both walks name the same refusal reason —
and fails if any statement disagrees (0 do).

**Where both walks still stop.** An unterminated string and an unbalanced
`(`/`[`/`{` have no knowable end, so there is no boundary to resume from. A `;`
is a third and deliberately so: it is a statement boundary the segmenter owns,
and resuming after it would read the next statement's bytes as this one's
arguments. No corpus statement reaches any of the three, and that is a property
of the pipeline rather than luck: an unterminated string and an unbalanced
delimiter are document defects the segmenter and resolver answer first, so no
addressable statement with an argument list is produced at all, and a `;` is
split into two statements before any argument is lexed. The unbalanced case is
also the one place the two readings name a different reason, and it follows from
what each needed: the strict walk refuses a `[…]` on sight and never asks where
it ends, while the tolerant walk asks — because the answer is what it would
resume from — and says `an unclosed structured argument value` when there is
none.

**What it moved, including the cost.** The `arg` fill now paints the `name=` run
of a token whose value only the device knows, so classified bytes go 69.77% →
**71.73%** (`arg` tokens 11,438 → 16,526). On the device-agreement slice the
bytes where the device decided and centrs abstained drop 5,540 → 4,158, and two
whole cells (`unclassified` → `arg-dot`, `unclassified` → `arg-scope`) empty
out. Against that, projection disagreements rise 143 → 360, and **every one of
the 217 new bytes is the `=` of an attribute**: `arg` → `syntax-meta`, one cell,
358 runs. That is not a new wrong assertion. It is #293's provisional
vocabulary — one `arg` class for both the name bytes and the `=` — meeting the
device's context-dependent answer over 2.5x as many bytes as before, and it
gave #264 B5 a concrete, counted reason to split the `=` into its own class.
It did, and the relabel moved no byte coverage at all: disagreements fell
360 → 2 and the classified-byte census did not change by a digit.

**The one residue, sized so it is not mistaken for a defect.** A `\<newline>`
continuation inside an argument leaves its token `undecided`, because the bytes
of a continued value are not contiguous and a `valueSpan` over them would be a
lie (`args.ts` → *What it refuses*). The conservative case is a token whose
value is already complete BEFORE the continuation, which is then withheld
needlessly. Measured on the 948-script corpus: 109 statements make the strict
lexer refuse for this reason, the tolerant walk reaches 114 statements carrying
138 such tokens, and **all 138 put the continuation immediately after the `=`**
— the value really does live on the next line. Exactly **one** token
(`mode=none\<newline>`) has a complete value in front of its continuation. So
narrowing the rule would recover one token, and deciding it correctly needs the
device-grounded answer for what a continuation does to a value's INTERIOR, which
is #225's probe-matrix territory rather than a lexer tweak. Recorded there; not
carried as pending work here.

**What the public surface gained, and what it did not.** The package root
exports the reading itself — `lexExplainArgumentTokens` and
`ExplainArgumentTokenReading` — for the same reason `lexExplainValueAnchors` is
exported: a consumer building its own token-level rule needs the reading a rule
wants, not the one a renderer wants. What did NOT change is the *envelope*:
`explainCommand`'s `structure.statements[].arguments` is still the strict
reading, `ExplainArgumentToken` carries no `undecided` field, and `undecided`
never appears on an `ExplainArguments` reading, because the strict lexer
publishes no token it could not decide. Whether the tolerant stream should reach
the envelope in its own right — so a browser consumer reading `explainCommand`'s
result can see a located `gateway=` whose value is a runtime expression — was
left to #264 B5, which decided it reaches the envelope **as the token
partition** and nowhere else: naming the `=` `arg-sep` locates the argument
without loosening `arguments`, and `undecided` stays off the envelope. See
[The vocabulary](#the-vocabulary-and-what-earns-a-class-264-b5).

### The menu path with arguments (#324)

A run that is nothing but a **known menu**, with arguments after it and no
verb, used to come back `resolved` with a verb the analyzer made up.
`/ip/firewall/address-list name=ytkids timeout=1h` reported path
`/ip/firewall`, verb `address-list`; the spaced spelling
`/ip firewall address-list name=x` promoted `firewall`, one level higher
still. The punctuation half of the ratified Q6 rule is what fires — "no space
token, arguments follow, so the last run token is the verb", or "the first
space token is the verb" — and neither premise it needs was ever checked:

```text
isKnownMenuPath(/ip/firewall/address-list)  ->  true      (it is a menu)
VERBS.has("address-list")                   ->  false     (it is not a verb)
```

This is the **symmetric half of R9**. R9 (#211 B1) made `pathresolve`'s
`menuNavPath` consult `VERBS` so it could not claim navigation where
`verbsplit` had decided a verb; this makes `resolveVerb` consult the menu
tables so it cannot claim a verb where the whole run names a menu and the
segment it would promote is not a verb. The reading degrades to **`ambiguous`**
with the standard located `explain/canonicalizer/ambiguous-statement` warning,
naming both premises. The adjacent readings are untouched —
`/ip/firewall/address-list add name=x` resolves, the bare path is navigation,
`/system/reboot` is a command — which is what makes this a seam rather than a
parser limit.

**It abstains; it does not reject.** Offline knows it cannot name a verb here,
and that needs no device evidence. Whether RouterOS refuses the shape outright
is a *device* claim, so unlike #311's CHR-grounded `error` this stays a
warning and the statement carries no verdict about acceptance.

**Four exclusions, each for its own reason.** A frozen-vocabulary hit is
excluded by the `VERBS` premise itself (a vocabulary split promotes a `VERBS`
member by construction). A **published command** is excluded by `catalogAt`:
first-order evidence about that exact path outranks a container listing of its
prefix, which is what keeps `/system/gps/monitor once` resolved. A scripting
**directive** is excluded by R10, which is measured. And a `{` after the run is
excluded by shape: that is a menu *container* body (`/system {identity print}`,
H7) where the run legitimately names a menu and no verb is missing —
abstaining there would drop the `invalid-command-brace` error the statement
after it carries.

**Priced before landing, as #211 B2 asks.** Over the frozen dev/holdout
partition (948-script corpus, 17,212 statements) **10 statements flip, all
`resolved` → `ambiguous`**: 1 dev, 9 holdout. **None is a genuine no-verb
command.** Three are real RouterOS missing a verb —
`/ip/firewall/address-list name=ytkids …`, `/interface bridge [find]
vlan-filtering=yes`, `/user-manager user [find …] attributes=…` — and seven
are pasted non-RouterOS prose: five Python traceback `File "…"` lines,
`User ID: 506`, and `port 80`. Those seven reach the rule at all because
`/file`, `/user` and `/port` are real menus and the table lookup folds case,
which is #203's genre bias arriving through a second door. Every one of the
ten was a fabrication, so the abstention has no measured false-positive cost
on this corpus.

**The execute gate is unmoved**, as the constitution requires: `canonical`
still reports `mode: "structured"`, path `/ip/firewall`, verb `address-list`
for this input, because that is what `canonicalizeExecuteCommand` decides and
an explain-only abstention may not reinterpret it. `enforceGateParity` is
about the argument *list* of a `kind: "command"` reading, so it does not fire
on a statement that carries no reading at all — the gate and the analysis are
two answers to two questions, and only one of them changed.

The invariant this closes — `pathresolve` and `verbsplit` never contradict
each other on one statement — is asserted in
`test/unit/explain-pathresolve.test.ts` beside R9's own cases. Presence in the
shipped structure tables still narrows a reading and absence still decides
nothing (#207/#228), so an unlisted menu spelled `…/address-list` is read
exactly as before.

### String escape validation (#247, #252)

The accepted set is the **device's**, not the manual's. The
[Scripting manual's constant-escape table](https://manual.mikrotik.com/docs/developer-guides/scripting/#constant-escape-sequences)
is a *lower bound*: it omits `\?`, and it documents the whitespace continuation
only under a separate "Line joining" section. Treating that table as a closed
allow-list is what #251 did and what #252 had to undo — it made 44 device-valid
corpus scripts read `fail`. The set below comes from sweeping `:put "\<c>"` over
every byte `0x20`–`0x7E` plus TAB/LF/CR/CRLF on CHR 7.23.3, scored on both the
`/console/inspect request=highlight` class and the runtime result:

- `\"` `\\` `\n` `\r` `\t` `\$` `\_` `\?` `\a` `\b` `\f` `\v`
- `\XX` where `XX` is **uppercase** hex
- `\` followed by whitespace (space, TAB, CR, LF, CRLF) — a **line
  continuation**, valid inside a string and not just in code. The device
  swallows the pair and emits nothing (`:put "a\ b"` → `ab`). CRLF counts as one
  continuation, so it is the only non-hex three-byte escape.

Everything else is rejected, including `\` before a non-ASCII byte. `\$` is
grounded on `highlight` (`escaped,escaped`, no `error` on CHR 7.23.3/7.24rc3)
and the manual; the `:parse` wrapper (`:put [:parse "..."]`) is not used for
that escape because outer-string escaping makes the inner `\$` appear as `$` to
the parser — for the same reason #252's rows are grounded by executing the input
directly rather than through the wrapper. Grounded on CHR 7.23.3 stable and
7.24rc3 testing (`highlight` hard `error` + `:parse` `expected message value`
for the three issue rows `:put "\q"` / `:put "\x0a"` / `:put "\0a"` vs
`":put "\0A"` valid):

- A malformed escape (`\q`, `\x`, `\x0a`, truncated single-hex `\0`, lowercase
  hex `\0a`/`\5f`) is a located `bad-string-escape` structural defect
  (severity `error`) at the byte the device marks `error` — the unknown char or
  the lowercase second hex digit. For a truncated single-hex escape the device
  marks the closing quote; centrs reports at the backslash instead, because that
  byte is stable when the string is unterminated.
- `\ff` is `\f` + literal `f` and `\aF` is `\a` + `F`; neither is invalid hex.
- The one shared `scanQuotedString` below every walker still **recovers the
  closing quote** past a malformed escape, so no #199 nested-substitution
  quote-phase bug is reintroduced. Validation is a shared
  `collectStringEscapeDefects` walk with the same substitution frames; only the
  first invalid escape per document is reported and it fails closed after it.
- Corpus blast radius (948 scripts): **4** `bad-string-escape` diagnostics (vs
  15 code-position `bad-escape`), and the device rejects all 4. Under #251's
  closed allow-list this was 62 flags of which **44 were false positives on
  valid RouterOS** — mostly multi-line `source=`/`on-event=` strings (`\`+LF)
  and `\?`.
- Scoring a defect rule against the corpus needs the right oracle.
  `parseil_results.ok` is **not** one: `:parse` never throws, it returns a
  diagnostic *value*, so the capture records `ok=1 / status="ok"` for scripts
  the device rejected (only 3 of 2739 rows are `ok=0`, and those are capture
  failures). The verdict is in `il_text` — plain prose such as
  `expected input value (line 7 column 49)` means rejected, IL means accepted.

### The operator surface (#255)

Grounded, not transcribed, for the same reason the escape set above is: the
[manual's operator list](https://manual.mikrotik.com/docs/developer-guides/scripting/index.md#operators)
is a lower bound. `bun run explain:probe:operators` sweeps the manual's list
**plus** plausible non-operators (`not`, `..`, `xor`, `mod`, `is`, `div`, …)
**plus** every IL head the corpus census saw, on CHR 7.23.3 stable, 7.24rc4
testing and 7.21.5 long-term — one build per release channel, so a claim about
any channel is evidence rather than an assumption. Re-cut the fixture with
`bun run explain:operator-slice`; the table
below is generated from `src/explain/operators.ts` by
`bun run explain:operator-readme` and gated by
`bun run explain:operator-readme:check`.

**`:parse` IL is the oracle, and `highlight` cannot be.** IL is prefix form with
the operator as its node's head, so it names the operator and shows its
operands. `highlight`'s `syntax-meta` is the device's *residual structure*
class — measured over `test/fixtures/explain/highlight-streams.slice.json` it
covers `=`, `"`, `$`, brackets, braces, parens, `;`, `,`, `/` and whitespace
runs as well as `||`, `&&`, `!=`, `.` and `~` — and adjacent runs are **merged**
(`="`, `($`, `")+` each arrive as one token; the run around `and`, `or` and `in`
swallows the preceding space). An operator boundary is not recoverable from it.
What it does decide is *structure versus word*, which is what rules `not` out:
it comes back `variable-undefined`.

Five things the device says that the manual does not:

1. **`not` is not an operator.** Nor are `xor`, `mod`, `is`, `div`, `band`,
   `bor`, `shl`, `shr`, `eq`, `ne`. Inside a paren group a bare word is a
   **variable reference**, so `(1 not 2)` parses — as `(  1 $not 2)`, with an
   unnamed juxtaposition node. "It parsed" is therefore not evidence of an
   operator, which is what the sweep's `(1 zzz 2)` control exists to prove.
2. **`..` is not a range operator** — `(1 .. 2)` is `(  (. 1 $.) 2)`, concat
   applied to a variable named `.`. Same for `//`. And `<>` is not "not equal":
   `(1 <> 2)` is `(< 1 (> 2))`, less-than applied to a *deferred* `2`.
3. **`$`, `[`, `]` are syntax, not operator heads.** `$x` stays an atom in the
   IL and `[:tostr 1]` lowers to an `evl` node. Those bytes belong to the
   substitution axis.
4. **`any` is an operator** (prefix, arity 1) and is not in the manual's list — a **nil-check**: `:typeof (any x)` is `bool`, `false` only for `nil`/`nothing` (the value of an undefined `:local` and of `[:nothing]`), `true` for everything else including `0`, `""` and `false`.  It is the idiom `:if (any $x) ...` to test a variable that may be `nil`; `(true any false)` is not infix at all but juxtaposition `(  true (any false))`, and `(1 . any [:nothing])` is concat `1`+`false`.  Present since at least 7.20.8 (corpus `any|7.20.8:2`, and swept live on 7.21.5 long-term, 7.23.3 stable and 7.24rc4 testing with no difference between them).
5. **`&&` and `||` are spellings**, lowering to the `and` and `or` nodes.

The `(>…)` and `<%%` forms are in the table on the same footing as `+`.
`(> x)` at arity 1 is the deferred-expression form — `[:typeof (>[:return 1])]`
is `op` — while `(2 > 1)` at arity 2 is the comparison; **arity is the only
thing that separates them**, so a table keyed on spelling alone gets one wrong.
`<%%` applies a deferred expression to an argument array, binding positionals
from `$0`; a `do={…}` function binds the same arguments from `$1`, because
there `$0` is the function's own name.

Both `!` and `any` are prefix-only, so the *pair* sweep cannot carry them and
their `precedence` is honestly `null`. That is "unmeasured", not "unknown": the
sweep asks them separately, every `(U 1 B 2)` and `(1 B U 2)` for
`U`∈`!`,`any`,`~`,`-`,`>` against all 24 binaries — 240 probes, recorded in the
fixture's `unary` block. All 240 are accepted and the **binary is outer in every
one**, on all three versions, so each prefix operator binds tighter than every
binary including `->` (14) and `<%%` (13). The table stores one `precedence` per
spelling, which is the binary level; `~`, `-` and `>` are here because their
unary reading has no other record.

Spacing decides the *tokens*, not just the tree. `(1.2)` is an IP literal and
`(.1)` a time literal, but the rest of the matrix is where a tokenizer goes
wrong: `(1 . 2)` and `(1 .2)` are both concat (`(. 1 2)`), while **`(1. 2)` is
not concat at all** — `1.` lexes as a *variable name* and the row comes back as
juxtaposition, `(  $1. 2)`. A rule that claims every `.` byte for the operator
emits a span the device does not have.

Everything in the sweep is identical across 7.21.5, 7.23.3 and 7.24rc4 except
one runtime row: `:put ({2;1} > {1;2;3})` evaluates to `true` only on 7.24rc4.
Identical is measured, not assumed — the slice diffs verdict, arity, precedence,
associativity, `highlight` run, unary placement and op-axis per version. So the
operator table needs no version gate; anything reporting what a comparison
*means* does.

<!-- BEGIN GENERATED operator-table — regenerate with `bun run explain:operator-readme` -->
The device builds a node for **26** spellings, reads **3**
as something else, and refuses the other **33** the sweep asked about.

| operator | arity | precedence | associativity | category |
| -------- | ----- | ---------- | ------------- | -------- |
| `,` | 2 | 1 | variadic | concatenation |
| `or` | 2 | 2 | variadic | logical |
| `and` | 2 | 3 | variadic | logical |
| `in` | 2 | 4 | left | logical |
| `<` | 2 | 5 | left | relational |
| `>` | 1, 2 | 5 | left | relational |
| `=` | 2 | 5 | left | relational |
| `<=` | 2 | 5 | left | relational |
| `>=` | 2 | 5 | left | relational |
| `!=` | 2 | 5 | left | relational |
| `~` | 1, 2 | 5 | left | relational |
| `.` | 2 | 6 | variadic | concatenation |
| `<<` | 2 | 7 | right | bitwise |
| `>>` | 2 | 7 | right | bitwise |
| `\|` | 2 | 8 | variadic | bitwise |
| `^` | 2 | 9 | variadic | bitwise |
| `&` | 2 | 10 | variadic | bitwise |
| `+` | 2 | 11 | variadic | arithmetic |
| `-` | 1, 2 | 11 | left | arithmetic |
| `*` | 2 | 12 | variadic | arithmetic |
| `/` | 2 | 12 | left | arithmetic |
| `%` | 2 | 12 | left | arithmetic |
| `<%%` | 2 | 13 | right | apply |
| `->` | 2 | 14 | left | access |
| `!` | 1 | not measured | not measured | logical |
| `any` | 1 | not measured | not measured | logical |

Precedence runs 1 (loosest) to 14 (tightest), measured over every
ordered pair rather than transcribed. `variadic` means the device FLATTENS
the operator — `(1 + 2 + 3)` is one node with three children, not two nested
ones. The 2 prefix-only operators never appear in a pair and so
carry no measured level.

Spellings the device reads as something else:

| spelling | reads as | kind |
| -------- | -------- | ---- |
| `&&` | `(<%% (and 1 2) )` | alias |
| `\|\|` | `(<%% (or 1 2) )` | alias |
| `<>` | `(<%% (< 1 (> 2)) )` | re-lexed |

And the grounded complement — asked, and refused:

| spelling | why not |
| -------- | ------- |
| `not` | reads-as-variable |
| `xor` | reads-as-variable |
| `mod` | reads-as-variable |
| `is` | reads-as-variable |
| `div` | reads-as-variable |
| `band` | reads-as-variable |
| `bor` | reads-as-variable |
| `shl` | reads-as-variable |
| `shr` | reads-as-variable |
| `eq` | reads-as-variable |
| `ne` | reads-as-variable |
| `line` | reads-as-variable |
| `array` | reads-as-variable |
| `as` | reads-as-variable |
| `at` | reads-as-variable |
| `for` | reads-as-variable |
| `none` | reads-as-variable |
| `outside` | reads-as-variable |
| `evl` | reads-as-variable |
| `..` | reads-as-variable |
| `//` | reads-as-variable |
| `**` | rejected |
| `===` | rejected |
| `+=` | rejected |
| `++` | rejected |
| `?` | rejected |
| `?:` | rejected |
| `<%` | rejected |
| `%%` | rejected |
| `;` | rejected |
| `$` | juxtaposition-only |
| `[` | rejected |
| `]` | rejected |
<!-- END GENERATED operator-table -->

  <!-- BEGIN GENERATED token-census — regenerate with `bun run explain:token-census:readme` -->
  The token census is re-derivable with `bun run explain:token-census` and
  covers 948 source scripts. The figures below are generated from
  `test/fixtures/explain/tokens.json` → `corpus` by
  `bun run explain:token-census:readme` and gated against it by
  `bun run explain:token-census:readme:check`; the fixture itself is gated
  against a fresh corpus run by `bun run explain:token-census:check`. Of
  1,426,731 analyzed bytes, 1,023,405 are classified (71.73%), the remaining
  403,326 are `unclassified`. The census emits 231,026 tokens (avg 243.7 per
  script). Every byte belongs to exactly one token — sorted by `start`, no
  gaps, no overlaps, `join(slice) === input` — and the `class` field is the
  vocabulary #264 B5 settled. Each B2 fill should move the classified
  percentage.
  <!-- END GENERATED token-census -->

B1's `data.tokens[]` is live behind `--tokens` — a total, gapless byte
partition whose `class` draws on the vocabulary #264 B5 settled (every unclaimed
byte is `unclassified`). Since B1 its only fill source was `data.spans[]` (comment runs
and resolved variable occurrences); **the path fill claims resolved menu and
command-name bytes as provisional `dir` / `cmd` tokens**, including valid path
slashes and nested command substitutions, while ambiguous, malformed, and
source-unmapped runs stay unclassified. A substitution's bytes are located by
the resolution's published **`innerSpan`**, never by arithmetic on its `span`:
`span` covers `[…]` for a bare substitution but `$[…]` for one interpolated
inside a string (the sigil is part of it), and `inner` is trimmed on top of
that, so `span.start + 1` was one byte early in a string and two bytes wrong
for `[ … ]`. Both refused the fill's slice check and fell through to the
string fill, which is how a command `structure.subcommands` had already
resolved came back as opaque `string` bytes (#325). The check itself stays:
where `Loc` widens the resolution to its statement, the slice no longer equals
`inner` and the bytes are left unclaimed rather than landed on the wrong
place. **`#293`'s arg fill** in
`src/explain/arg-tokens.ts` then claims argument names as `arg` (name run
`[span.start, valueSpan.start - 1)`) and the single `=` byte at
`valueSpan.start - 1` as `arg-sep` (#264 B5) on the residual left by spans,
before operators see it
— and **`#295`'s value fill follows it** — `src/explain/value-tokens.ts`
claims argument value bytes and leaf array-literal members
(`data.values.occurrences`, leaves only via `parent` containment,
quotes-included) on the residual left by `spans`+`path`+`arg`, before the
**B3 string/brace fills** see it — `src/explain/string-tokens.ts` claims
quoted-string runs (delimiters included) and `src/explain/brace-tokens.ts`
claims every residual brace delimiter (`{`/`}`), including delimiters from
invalid braced references, on the residual left by
`spans`+`path`+`arg`+`value`, and finally `operator` sees only what none of
them wanted — which is why the operator fill can abstain on `, / = -` outside
`( )`, on bytes glued after an argument `=`, and on bytes glued into an
argument name without a smarter operator scanner. Fill order is enforced by
argument order to `buildTokens` ([#290 design decision 1](../../src/explain.ts)):
`spans` claims first, then `path`, `arg`, `value`, `string`, `brace`, and
finally `operator`.
`ExplainTokenClass` is
`ExplainSpanClass | "dir" | "cmd" | "operator" | "arg" | "arg-sep" | "value" |
"string" | "brace" | "unclassified"` — one `operator` class for all 26
spellings + 2 aliases, `arg` for an argument's name bytes and `arg-sep` for the
single `=` that binds it to its value, one `value` class for every leaf value
span, plus `string` (quoted runs) and `brace` (scope delimiters). #264 B5
settled which of those merges keep their name and which do not, on a stated
rule rather than taste — see
[The vocabulary](#the-vocabulary-and-what-earns-a-class-264-b5).
`ExplainSpanClass` and `data.spans[]` stay proof-only; `src/explain/operators.ts`
remains data plus accessors, and the operator table above is its source. The
`centrs → highlight` projection is B4 and reads both.

**Where the operator fill abstains.** Fill order is the resolution mechanism, so
a byte that is structurally part of a path or an argument is left
`unclassified` for the path/arg fills rather than claimed. Three abstentions,
each grounded on the corpus device oracle (`parseil_results.il_text`):

| Abstention | Grounding |
| ---------- | --------- |
| `, / = -` outside a `( )` group. `(` opens an expression; `[` opens a **command substitution** and `{` a block or array literal. | The IL for `[ /system/identity/get value-name=name ]` is `(evl /system/identity/get value-name=name)` — path separators and an argument separator, no division and no comparison node. |
| A spelling glued immediately after an argument `=`. | `in-interface-list=!LAN`, `.id=*2`, `oid=.1.3.6.1.2.1` — the byte after an argument `=` starts the value. |
| A spelling glued into an argument **name**. | `:foreach x in=$list` is `/foreach counter=$x` with no `(in …)` node anywhere; the IL keeps `security.authentication-types=wpa2-psk` as one name and renders `.id` as the single symbol `$.id`, never `(. …)`. |

The first abstention has a measured cost: `find where name="x"` inside `[ … ]`
*does* lower to a real `(= $name x)` node, so 224 of the corpus's 1,259
bracket-interior `=` bytes are genuine comparisons that now stay
`unclassified` — against 1,035 that were plain `arg=value`. A `where`-aware
fill can take them back later; claiming all 1,259 would be 82% wrong.

### Device agreement for the token partition (#264 B4, #263)

The census above counts what offline analysis *claimed*. This counts what the
device *agreed with*. The oracle is the committed stratified slice of the Q13
`/console/inspect request=highlight` captures
([`test/fixtures/explain/highlight-streams.slice.json`](../../test/fixtures/explain/highlight-streams.slice.json)),
so the scorer needs no router, no corpus and no network, and gates in the unit
suite rather than in the corpus job. Both oracles must see the same bytes, so
the source text is reconstructed from the device's own run-length pairs — never
from the corpus row, which still holds the non-ASCII the capture replaced
(the #269 rule, one layer up).

**`highlight` is not one oracle; it is four kinds of answer.** Scoring a byte
means first knowing what kind of answer came back, because three of the four
are not judgments about syntax at all:

| Kind | Classes | Why it cannot be scored as agreement |
| ---- | ------- | ------------------------------------ |
| syntax | `cmd` `dir` `arg` `arg-dot` `arg-scope` `comment` `escaped` `syntax-meta` `variable-local` `variable-global` `variable-auto` `variable-parameter` | — this is the region that can be scored |
| non-syntax | `obj-inactive` `obj-dynamic` `obj-disabled` `variable-undefined` `syntax-obsolete` | The source text alone does not decide these. centrs has no class for most of them at all — `ExplainSymbolClass` deliberately excludes `undefined` — and where it *does* claim the byte (an `arg` the device calls `obj-inactive`) it is the **scorer** that abstains, because the device was not making a syntax judgement there. *Why* each one is out of reach is a second question, answered per byte rather than per class; see applicability below. |
| silence | `none` | The device's abstention, not a class named "none". Agreeing with silence is not agreement. |
| parser-stop | `error` | The device gives up here — see below. |

**Applicability is a second axis, and it is not the class name.** #263's four
categories — offline-decidable, schema-dependent, state-dependent,
version-dependent — are assigned from the *pair* (what centrs read the byte as,
what the device called it) plus whether the two captures even agreed, because
one highlight class carries more than one category. Version disagreement is
checked first, ahead even of the device's own silence: a byte one build
classifies and the next leaves `none` is a version difference, not an absence.
`obj-inactive` on an argument name means the menu's schema has no such field
(**schema** — `default-vlan-id`, under an `/interface ethernet switch port` a
CHR does not have); the same class on a menu or command name means the package
is not installed on this box (**state**: `/zerotier`, `/user-manager`,
`/container`). `obj-dynamic` on the routing table `main` is a live object
(**state**).
`syntax-obsolete` is this version's deprecation table talking, landing on the
whitespace where modern syntax wants `=` (`} else {`, `:foreach conn in
$conns`) — **version**. And `variable-undefined` is deliberately left
**uncategorized**: an undefined reference may be an external global, a
query/filter field name or a lexical spelling, nothing committed here separates
the three, and an absent binding in *this* document is not evidence of a
runtime undefined variable either. Leaving it explicit is the answer, not a gap
to be filled by assumption.

**The device stops classifying at its first `error`, and mostly does not
recover.** Measured over the slice, `error` appears **at most once per script
and is always exactly one byte wide**, and on 7.23.2 every byte after it comes
back `none`. Most of the slice sits in that tail. A percentage computed over
the whole stream therefore measures the device giving up, not the parser, which
is why the tail is its own outcome and is never folded into agreement. The rule
is not absolute across versions, so the report does not assert it: 7.24rc2
classifies again after its `error` in one run and stops on fewer scripts, and
`parser-recovered` in the table below is the figure that says by how much —
zero would have been the claim, and it is not zero. Both counts are generated,
not quoted here, so neither can go stale against the fixture.

**The projection is declared, never fitted.** `src/explain/highlight-projection.ts`
maps each centrs token class to the device classes it predicts, justified by
what the class was *defined* to mean rather than by where it happened to land.
A projection tuned to the measurement would make the measurement circular. So a
class whose intent has no single device counterpart — `string`, which spans a
delimiter the device calls `syntax-meta`, escapes it calls `escaped` and an
interior it declines to classify, and `value`, for which the device has no class
at all — projects nowhere, and its bytes are counted as `unprojected` with the
device's own answers tabulated beside them. That table is the evidence #264 B5
needs in order to decide which provisional merge deserves to be split; it is not
a score.

<!-- cspell:disable — the example table quotes corpus script paths verbatim, forum-thread typos included -->
<!-- BEGIN GENERATED highlight-agreement — regenerate with `bun run explain:highlight-agreement:readme` -->
The agreement report is re-derivable with
`bun run explain:highlight-agreement` and needs no router and no corpus: it
scores the token partition against
`test/fixtures/explain/highlight-streams.slice.json`, 70 stratified scripts of
committed `/console/inspect request=highlight` output. The figures below are
generated from `test/fixtures/explain/highlight-agreement.json` by
`bun run explain:highlight-agreement:readme`, gated against it by
`bun run explain:highlight-agreement:readme:check`, and the fixture itself is
gated against a fresh measurement by
`test/unit/explain-highlight-agreement.test.ts`. Of 85,529 bytes at 7.23.2,
26,794 are bytes **both** sides decided a syntax class for, and 99.99% of
those agree (dev 99.99%, holdout 100.00%). Set `comment` aside — it is 67.20%
of that decided region and mostly the corpus's harness-injected `# Source:`
banner (#203) — and the remaining 8,788 bytes agree 99.98%. The device stops
classifying at its one-byte `error`: 43 of 70 scripts carry one, and the
43,417 bytes from there on are not a judgment about anything. The oracle
itself moves between captures: 43 stop at 7.23.2 and 36 stop at 7.24rc2, and
27 of the 70 streams differ between them. **This is a trend line, not a pass
gate** — the slice is a per-(split, class) quota over a corpus that is 96.8%
two authors, so the percentage describes this slice.

| centrs class | projects to | agree | disagree | unprojected | of decided |
| ------------ | ----------- | ----: | -------: | ----------: | ---------: |
| `comment` | `comment` | 18,006 | 0 | 0 | 100.00% |
| `variable-local` | `variable-local` | 1,088 | 0 | 0 | 100.00% |
| `variable-global` | `variable-global` | 582 | 0 | 0 | 100.00% |
| `variable-auto` | `variable-auto` | 92 | 0 | 0 | 100.00% |
| `variable-parameter` | `variable-parameter` | 398 | 0 | 0 | 100.00% |
| `dir` | `dir` | 1,606 | 0 | 0 | 100.00% |
| `cmd` | `cmd` | 2,126 | 0 | 0 | 100.00% |
| `arg` | `arg`, `arg-dot`, `arg-scope` | 2,111 | 0 | 0 | 100.00% |
| `arg-sep` | `syntax-meta` | 358 | 0 | 0 | 100.00% |
| `operator` | `syntax-meta` | 232 | 2 | 0 | 99.15% |
| `brace` | `syntax-meta` | 193 | 0 | 0 | 100.00% |
| `string` | *abstains* | 0 | 0 | 886 | — |
| `value` | *abstains* | 0 | 0 | 165 | — |

| outcome | bytes @7.23.2 | bytes @7.24rc2 |
| ------- | ----: | ----: |
| agree — both decided, projection accepts | 26,792 | 27,546 |
| disagree — both decided, projection rejects | 2 | 2 |
| unprojected — no declared projection covers the pair | 1,051 | 1,061 |
| offline-silent — device decided, centrs abstained | 4,158 | 4,308 |
| non-syntax — the device answered something syntax cannot decide | 733 | 847 |
| device-silent — centrs decided, device said `none` | 5,674 | 5,815 |
| both-silent | 3,702 | 3,886 |
| parser-stopped — at/after the device's `error` byte, and silent from there | 43,417 | 41,968 |
| parser-recovered — past that `error`, and the device classified anyway | 0 | 96 |

Where the device decided and offline analysis did not (4,158 bytes at 7.23.2,
the next fill's target list): `syntax-meta` 3,000, `comment` 350,
`variable-local` 310, `arg` 190, `escaped` 145, `dir` 68, 95 across the rest.
Most of the `syntax-meta` share is whitespace the device merged into an
adjacent structure run rather than a token centrs missed.

**Applicability** is the second axis (#263): of the bytes the device did
answer, what kind of fact was it answering? Assigned from the pair — what
centrs read the byte as and what the device called it — plus whether the
captures agreed, never by assigning a whole class to one category. It covers
every measured byte, the post-`error` tail included: where one capture stops
parsing and the next does not, that tail IS the version disagreement, which is
why it dominates the category.

| applicability @7.23.2 | bytes | leading cells |
| ---------------------------- | ----: | ------------- |
| offline-decidable | 32,002 | `comment` → `comment` 18,006, `unclassified` → `syntax-meta` 2,999, `cmd` → `cmd` 2,126 |
| schema-dependent | 326 | `arg` → `obj-inactive` 326 |
| state-dependent | 168 | `dir` → `obj-inactive` 120, `cmd` → `obj-inactive` 21, `unclassified` → `obj-dynamic` 20 |
| version-dependent | 1,158 | `comment` → `none` 353, `unclassified` → `none` 285, `arg` → `none` 128 |
| uncategorized | 213 | `unclassified` → `obj-inactive` 90, `unclassified` → `variable-undefined` 75, `value` → `variable-undefined` 21 |
| no-device-answer | 51,662 | `none` where the captures agree, wherever it falls |

One representative run per cell, so B5 reads a fragment rather than a count.
`runs` is how often that exact fragment occurs; the location is a slice script
and a byte offset into the stream the device saw.

| outcome | cell | fragment | runs | first at |
| ------- | ---- | -------- | ---: | -------- |
| disagree | `operator` → `arg` | `"in"` | 1 | `forum/amm0/topic-169456-having-the-where-filter-in-scripting-signifantly-increases-the-execution-time-an/post-0006-snippet-01.rsc` @615 |
| unprojected | `string` → `syntax-meta` | `"\""` | 311 | `eworm/ppp-on-up.rsc` @435 |
| unprojected | `string` → `escaped` | `"\\\""` | 53 | `forum/amm0/topic-153357-using-wifiwave2-to-bridge-two-audience-wirelessly-thoughts-4-address-mode/post-0001-snippet-01.rsc` @559 |
| unprojected | `value` → `syntax-meta` | `"\""` | 88 | `forum/amm0/topic-153357-using-wifiwave2-to-bridge-two-audience-wirelessly-thoughts-4-address-mode/post-0001-snippet-01.rsc` @1436 |
| unprojected | `value` → `escaped` | `"\\00"` | 1 | `forum/rextended/topic-164329-post-0017-snippet-01.rsc` @243 |
| unprojected | `string` → `arg` | `"as-value"` | 1 | `forum/amm0/topic-266499-how-to-condense-variables-passed-through-to-function/post-0020-snippet-01.rsc` @279 |
<!-- END GENERATED highlight-agreement -->
<!-- cspell:enable -->

**What the disagreements are.** Two cells carry all of them, and neither is a
lexing accident:

- `arg` → `syntax-meta`: the `=` byte the `arg` class merges in. The device
  reads a separator as structure. This is the measured cost of the merge the
  token-census block already flags, and it is the single largest reason `arg`
  scores below the other name-coincident classes.
- `operator` → `arg`: the space-separated `in` of `:foreach conn in $conns`,
  which the device reads as the argument **name** `in`. The two oracles
  genuinely differ here — `:parse` IL carries `in` in the operator set, and the
  operator-abstention table above already records that `:foreach x in=$list`
  lowers with no `(in …)` node.

The third cell is gone. `cmd` → `dir` was the whole of #324 — a known menu path
carrying arguments and no verb, where `verbsplit` promoted the last segment;
those 12 bytes now abstain instead of disagreeing, and the 14 `dir` bytes the
same statements contributed to `agree` abstain with them. That is the price,
and [the fix states it](#the-menu-path-with-arguments-324): withdrawing a
fabricated verb also withdraws the menu reading it was built on.

The `unprojected` residue is what #264 B5 read to decide which merges to
split — [The vocabulary](#the-vocabulary-and-what-earns-a-class-264-b5) records
the verdict on each. It was also where #325 lived:
a quoted string claimed any `$[…]` substitution inside it, so bytes the device
resolves to `cmd` or `dir` came back as one opaque `string` run even though
`structure.subcommands` had already resolved that same span. Those cells have
largely emptied (`string` → `cmd` 42 → 3, `string` → `dir` 19 → 1, with the
same fix recovering padded bare brackets `[ … ]` from `offline-silent`), and
the two residues left are stated rather than fixed:

- `$(…)` — a **parenthesized** interpolation carrying a bracket, as in
  `apikey-len=$([:len $apikey])`. Only `$[` is scanned inside a string, so the
  inner command is not resolved there in the first place; this is a parser
  reach, not a fill-order question (4 bytes on the slice).
- a bare-word **argument** inside a substitution — `as-value` in
  `:put "$[/ip address print as-value]"`. The path fill claims the path and
  verb; the argument fill reads `statements[].arguments`, and a substitution is
  not a statement, so it has no candidate to claim (8 bytes).

The `$` sigil and the `[` / `]` delimiters stay `string`, and `value` bytes
are, to the device, simply unclassified — both settled by
[The vocabulary](#the-vocabulary-and-what-earns-a-class-264-b5) below.

### The vocabulary, and what earns a class (#264 B5)

`data.tokens[]` shipped with its `class` marked provisional from B1 onward —
emit first, name later (#293 design decision 2). This is the "name later", and
the vocabulary below is what `@tikoci/centrs/explain` offers a consumer. It is
no longer provisional.

**The rule a class has to pass.** A merged class is split when both hold, and
stays merged otherwise:

1. **A consumer needs the distinction** — it changes what that consumer renders
   or decides, not just how a token dump reads.
2. **The envelope cannot already supply it** — the distinction is not
   recoverable by joining `tokens[]` to another published surface on byte
   offsets.

The second test is the one that does the work. A class that restates a fact
`structure`, `symbols` or `values` already publishes is a second place for that
fact to go stale, and the two copies can then disagree about the same bytes. So
the question is never "would a name here be nice"; it is "what would a consumer
have to do without it". Applied to the five merges the fills carried, exactly
one passes:

| merge | what a consumer would do without it | verdict |
| ----- | ----------------------------------- | ------- |
| `arg` — the name bytes **and** the `=` | subtract one from `arguments[].valueSpan.start`, which exists only where the STRICT reading read. **5,088 of the 16,526 `=` runs the fill paints (30.8%, in 436 of 948 corpus scripts) sit in a statement whose `arguments` refused** — led by `do=` (2,393), `else=` (328) and `in=` (212), the block binder of every `:if`, `:foreach` and `:while`. For those there is nothing to subtract from. | **split** → `arg-sep` |
| `operator` — 26 spellings + 2 aliases | slice the input at the token's span: the spelling *is* the bytes, and `src/explain/operators.ts` maps it to its IL node | keep |
| `value` — every leaf, whatever its shape | join `data.values.occurrences[]` on the offset; #225's three axes (shape, observed, schema) live there, and a class per shape would be a fourth copy free to contradict them | keep |
| `brace` — scope and array delimiters | `structure.blocks[]` locates every scope block; an array container is the `values.occurrences[]` entry that is some other occurrence's `parent` | keep |
| `string` — delimiters, escapes, interior | the opening delimiter is the run's first byte and, where the run is closed, the last is its partner (an unterminated one is already a located defect). The **escapes are a different answer** — see below | keep, with one admitted candidate |

Re-derive the `arg-sep` figures with `bun run explain:arg-reach`, which prices
the same gap it prices the reach fork with.

**What the split cost.** Nothing, which was the claim and is now the
measurement. Classified bytes are identical — 1,023,405 of 1,426,731 (71.73%),
equal to the last recorded decimal before and after — and `arg` gave up exactly
the 16,526 bytes `arg-sep` claims, one per attribute. Token count rises 214,503
→ 231,026 because one run became two. **This is a retag.**

One count is not a clean split: `arg`'s own run count falls 16,526 → 16,523.
Three attributes lost their name run entirely, because an earlier `variable-*`
span had already claimed the name bytes — `set $ifcId ssid=$ssid`, and two
`on-error=` in one snippet — leaving only the `=` on the residual. Before the
split those three emitted a token *called* `arg` that contained nothing but an
`=`. That is the merge in miniature, and it is why the number goes down.

**The agreement number moved a long way, and it is still not a score.** Against
the committed device slice, projection disagreements fall **360 → 2** and the
decided region goes 98.66% → 99.99% (`arg` alone 85.50% → 100.00%). Read that
as the withdrawal of a wrong assertion, not as a parser that got better: centrs
stopped calling a separator a name over the 358 runs the device had been
reading as `syntax-meta` all along, and not one byte changed which analyzer
found it. The two survivors are the `operator` → `arg` `in` of
`:foreach conn in $conns`, where the two oracles genuinely differ.

The projection entry was **declared before the measurement, never fitted to
it**: `arg-sep` predicts `syntax-meta` because a separator is structure
punctuation, the same reason `brace` and `operator` predict it. The slice then
put 358 of 358 there.

**Where the tolerant reading reaches the envelope (#316's open decision).** It
reaches it *as the token partition*, and that is the only place it should.
`structure.statements[].arguments` stays the strict all-or-nothing reading,
because its consumer renders a runnable request and a half-read argument list
changes what the rendered command does. But with the `=` named, `tokens[]`
locates the argument on its own:

```text
/ip route add dst-address=1.1.1.1 gateway=$gw
  arguments: { read: false, why: "a variable value" }
  tokens:    … arg("gateway") arg-sep("=") unclassified("$") variable-parameter("gw")

:if ($x = 1) do={ :put "hi" }
  arguments: { read: false, why: "a substitution or expression value" }
  tokens:    … operator("=") … arg("do") arg-sep("=") brace("{") …
```

Neither statement publishes a single argument, and in both a browser consumer
can still see a located `gateway=` / `do=`. The second line is the
discrimination working as well: the same `=` byte is `operator` inside
`($x = 1)` and `arg-sep` in `do=`, decided by fill order and meaning rather
than by a byte scan.

What `tokens[]` still does **not** carry is the *reason* a value was not
decoded. `undecided` stays off `ExplainArgumentToken` and out of the
envelope: the envelope's value-fact surface is `data.values.occurrences[]`,
where absence at an offset already *is* the abstention, and a second spelling
of the same abstention would be free to disagree with it. A consumer that needs
the reason imports `lexExplainArgumentTokens` from the package root — which is
why that export exists.

**The one candidate the rule admits and this change does not make.** A *valid*
string escape is recoverable from nothing: only invalid ones surface, as
`bad-string-escape` diagnostics, and finding the rest means walking the escape
grammar (uppercase-hex `\XX`, the whitespace continuation, the twelve
single-character forms) that
[String escape validation](#string-escape-validation-247-252) already owns. The
device does class them. On the slice that is 53 `string` → `escaped` runs and 1
`value` → `escaped`, today counted `unprojected` because neither class has a
device counterpart for the whole run; splitting escapes out would let the
report score those bytes for the first time. It is a **fill change, not a retag** — the
grammar has to be walked inside both `string` and `value` runs — so it is its
own task, sized here rather than assumed, and it stays on #264.

Delimiters are the near miss that shows the rule discriminates rather than
rubber-stamps: `"` bytes are 311 `string` → `syntax-meta` runs and 88
`value` → `syntax-meta`, the device classes them too, and they stay merged
anyway, because a consumer can find them by looking at the run's own first and
last byte. The `$` sigil and the `[` / `]` of a substitution stay `string` on
the same ground — `structure.subcommands` already publishes the resolution, and
its `innerSpan` locates the brackets around it.

### Designed, not implemented (the CLI surface, #202b)

`src/cli/explain.ts` ships the offline command; implemented flags are generated
into [`docs/CLI.md`](../../docs/CLI.md) and are not restated here. What the
[Surface](#surface-option-a--decided) table above describes and the command does
**not** yet accept:

| Flag / form | Phase | Why it is not accepted yet |
| ----------- | ----- | -------------------------- |
| `explain <router> '<input>'` | 2 | The grammar is parsed and **refused** with `usage/not-implemented`, naming the router it did not contact. Running the offline analysis under an invocation that asked for probes would report `mode: "offline"` about a request for more. |
| `--cursor <byte>` | 2 | It positions `--complete`, which enumerates nothing offline. A cursor with no candidate surface to position is a flag with no effect. |
| `--full` | 3 | It lifts smart-sizing limits, and the offline result is never truncated (`input.truncated` is always `false`). Same rule: no accepted flag is a no-op. |

`--complete` and `--schema` **are** accepted, because they have an offline
behavior the spec names: they enumerate nothing and emit the live-target tip.
That is the difference — an accepted flag must do something observable.

## MCP and library surfaces

- **Consumers use the layer that answers their question.** Byte ranges and
  their classes (`spans` and the shipped `tokens` facet) serve editor/token
  consumers; the resolved reading (`structure`, `symbols`, `values`) carries
  path, verb, arguments, and value facts; doc/version enrichment belongs to
  rosetta (#175). A consumer that wants enrichment takes
  the **middle** layer: given `{path, verb, args}` plus a version it does its
  own lookups, whereas handing it tokens would make it re-derive from bytes a
  path centrs already resolved. So #223 is a decision about the structure
  layer, and the token vocabulary (#264) is deliberately outside its scope —
  the two do not need to be sequenced against each other. The same split says
  where a schema-shaped gap belongs: the per-path argument list `catalog.ts`
  refuses to be is enrichment, not lexing.
- `centrs_explain` today wraps `canonicalizeExecuteCommand` (offline, no CDB —
  the only tool that serves without one). It grows toward this spec
  **following the CLI scheme** (decision): same facets, same envelope-shaped
  data as the CLI's `--json`, optionally a CDB-resolved target for live
  evidence. The no-CDB offline path must survive, and the MCP adapter must
  not widen the structured gate. The current flat `centrs_explain` shape
  (`{ input, mode, path, verb, attributes, queries, writeShaped }`) is
  **superseded** when this lands — a deliberate pre-1.0 breaking change, with
  `commands/mcp/` examples and integration tests updated in the same change;
  no dual-shape compatibility layer is planned. **That supersession is held out
  of #202 and tracked in #223** (maintainer decision): `centrs_explain` and
  rosetta's tool surface must stay aligned for agent usage, which is a
  cross-project decision. Until #223 lands the MCP keeps its flat shape, so the
  CLI's `--json` and the MCP's `data` are **deliberately divergent**.
- Library: `explainCommand(input, options?: ExplainCommandOptions)` is the
  offline analysis (`src/explain.ts`, #202a/#202c) and
  `explainEnvelope(input, options?: ExplainEnvelopeOptions)` wraps it in the
  standard envelope. Both option types are exported. Phase 2 extends that same
  analysis bag with `target` and `facets`; `curl` stays an orthogonal rendering
  request, so offline and live calls do not need competing second-argument
  shapes. `lsp-routeros-ts` and
  tikbook are the intended external consumers (hover/diagnostics/completion/
  semantic tokens over these calls); an LSP *protocol* surface on centrs
  stays out of scope (#90). A bounded offline browser/editor consumption check
  now precedes vocabulary stabilization (#264 B5); full live LSP integration
  remains later work. The entry is `@tikoci/centrs/explain` and it is browser-verified —
  see [The offline package entry](#the-offline-package-entry-312).

### The offline package entry (#312)

**`@tikoci/centrs/explain` -> `src/explain.ts`** is the documented public entry for
offline analysis. It is a real boundary, not a naming convention: the module
graph reachable from it opens no connection, reads no CDB, and touches no
filesystem, so it bundles and runs in a browser, a Worker, or an editor host.

```sh
bun run explain:browser-consumer          # boundary + executed consumer report
bun run explain:browser-consumer --json   # machine-readable
```

Both halves are gated in the unit suite by
`test/unit/explain-browser-entry.test.ts`, so neither needs a router or the
corpus.

**Why a gate and not a note.** The entry reached the transport stack until this
landed, for two *pure* helpers: `toYaml` (from `retrieve.ts`) and
`canonicalizeExecuteCommand`/`isWriteShaped` (from `execute.ts`). Importing
either dragged in `mac-telnet` (`node:dgram`, `node:os`), `native-api`
(`node:crypto`) and `ssh`. Both now live in `src/core/` — `src/core/yaml.ts` and
`src/core/execute-command.ts` — moved character for character, with `execute.ts`
re-exporting the gate because it remains that gate's documented public home.
**Nothing about the script-vs-structured gate moved with them**; the locked
contract table in `test/unit/execute-canonicalize-contract.test.ts` still imports
from `execute` and still passes.

That coupling was re-introduced once already by a one-line import, which is why
the static half of the check names the offending **edge** (`explain.ts ->
execute.ts -> mac-telnet-console.ts -> mac-telnet.ts`) rather than leaving a
reader with the bundler's polyfill complaint four modules downstream.

**What "runs in a browser" is proven by.** Compilation is not the proof. A
bundler silently substitutes browser polyfills, so the check bundles a worker
entry around the module with `--target browser`, wraps the output in a function
that shadows every host global (`Bun`, `process`, `require`, `module`,
`exports`, `__dirname`, `__filename`), and **spawns that bundle as the Worker**.
`Bun` is a non-configurable global — `delete globalThis.Bun` throws — so
shadowing, not deletion, is what makes the absence real, and doing it in the
bundler's banner keeps the harness free of `eval`/`new Function` while making
the bundle text on disk the artifact that carries the claim.

It then compares the whole `ExplainData` against the Bun-native run, field for
field: structure, diagnostics, tokens, spans, `canonical`, and
`runtimeAcceptance`. Fourteen cases, covering normal and write-shaped commands,
multi-statement and nested input, three malformed classes, Unicode, astral, a
leading BOM, IPv6, empty input, and the facets switched off. All fourteen are
byte-identical today.

Two things the bundle deliberately exercises rather than bypasses. It imports
through the **published subpath** `@tikoci/centrs/explain`, not
`../src/explain.ts`, so a typo in `package.json`'s `exports` map fails the gate
instead of leaving it green while every real consumer breaks (the graph walk
additionally asserts that the `exports` entry and the measured file are the same
path). And it calls `resolveExplainFormat(undefined)`, whose `env` default is
the `typeof`-guarded `hostEnv()` — nothing else reaches that parameter, so
without this a regression to a bare `Bun.env` would pass every case here while a
browser caller of that exported function got a `TypeError`.

The shadowing is **measured from inside the bundle**, not assumed: the worker
reports which host globals it could still see, and an empty list is part of the
gate. Without it, a wrapper that silently stopped being emitted would leave
every "identical" above produced with host APIs in reach, proving nothing. Only
`Bun` and `process` are probed, because they are the only two of the seven a
bundle can honestly observe — Bun constant-folds `typeof require` to
`"function"` at build time, mentioning `__dirname`/`__filename` makes it inject
the build machine's absolute paths as local constants (the probe would cause
what it reports), and mentioning `module`/`exports` reclassifies the entry as
CommonJS, whose top-level `export default` is a syntax error inside the wrapper.
All seven stay shadowed regardless.

The one tolerated host builtin is **`node:net`**, for `isIP` in
`src/explain/values.ts` — a pure predicate with no socket in it. A bundler
replaces it with a regex pair, so the browser build genuinely runs a *different*
`isIP` than Bun does; the two IPv6 cases exist to price that substitution, which
is the only place its verdict is observable. A builtin that polyfills to a stub
(`node:fs`) or throws (`node:dgram`) could not be checked this way, so the
allowlist is a boundary, not a list to extend.

**What it does not claim.** Not that the `centrs` package works in a browser —
it does not, and is not meant to. Not DOM integration, no real browser engine.
And these cases are a boundary corpus, not a parser-coverage corpus; measured
parser evidence stays in the censuses and
[Device agreement](#device-agreement-for-the-token-partition-264-b4-263).

**What this hands #264 B5.** The comparison serializes the entire public result,
so it pins the vocabulary a consumer actually depends on: every `tokens[]` class
name, every span pair, and the `ExplainData` key set are now load-bearing across
a process boundary. A B5 rename is therefore a visible break here rather than a
silent one — which is the point of settling the vocabulary before an external
consumer commits to it.

## Non-goals

- No LSP server in centrs — the LSP is a consumer the library must support,
  nothing more.
- No execution probes; no state mutation of any kind.
- No fan-out.
- No rosetta/restraml integration at runtime (decision, amended by #228): no
  shell-outs, no calls, no vendored *schema* artifact, no version-history facts.
  The two generated structure tables are built from pinned public sources by
  scripts in `scripts/`, and centrs vendors its own CLI-Reference ETL rather
  than depending on rosetta for it. Output may tip toward rosetta for
  docs/version questions; deeper integration waits on centrs's shape settling
  and rosetta publishing stable consumable surfaces.
- No promise of enum exhaustiveness or of the upstream `completion-tricks`
  synthetic-probe recipes (still open research in lsp-routeros-ts
  `BACKLOG.md`) — candidates are labeled as observed, not closed sets.

## Phase-0 ratification (#185)

The phase-0 canonicalization grounding lab (#185, rev 2) is complete. It scored
a schema-free offline parser against device truth — `:parse` IL and
`/console/inspect` highlight, cross-checked on CHR 7.23.2 and 7.24rc2 — over a
frozen train/holdout split of the 913-script lsp-routeros-ts corpus, plus
constructed corner and mutation suites. Each question below names the spec claim
it gated and links its exit artifact (the artifact carries the fixture/split
hashes, RouterOS versions, oracle source, per-class precision/recall/abstention,
and disagreement samples). Probes are throwaway (`.scratch/`, non-authoritative);
the findings here are the deliverable, promoted per
`.github/instructions/routeros-grounding.instructions.md`.

**Ratified as designed:** Q1 statement segmentation · Q2 block topology · Q3
`[]` sub-command path re-constitution · Q4 stateful-per-document path context ·
Q6 no-schema verb/menu boundary (**decision 3 unchanged**) · Q8 tested REST
mapping rules + fail-closed boundary · Q10 `.proplist` recipe · Q13 symbol scope
classes.

**Amended the surface (folded in above):**

| Finding | Amendment | Exit artifact |
| ------- | --------- | ------------- |
| **Q16** write-shape | `structure.containsWrite` is three-valued `true \| false \| unknown` (boolean rejected as unsafe); zero false negatives on obvious writes; `unknown` separate from `false` | [#5027578882](https://github.com/tikoci/centrs/issues/185#issuecomment-5027578882) |
| **Q6/Q3/Q13/Q14** schema-free floor | a distinct **`ambiguous`** canonicalizer verdict; fail-closed rule promoted to the constitution | [#5025480566](https://github.com/tikoci/centrs/issues/185#issuecomment-5025480566) |
| **Q14** malformed/partial | diagnostics carry a **defect region**; fail-closed recovery (no invented commands after a defect; bare-word heads → `unknown`); `--complete` bounded offline | [#5048400737](https://github.com/tikoci/centrs/issues/185#issuecomment-5048400737) |
| **Q15** coordinates | ASCII-normalization is **byte-count-preserving** (non-ASCII byte → placeholder, one-for-one) so analyzed offsets ≡ highlight byte offsets; invariants validated 100% | [#5048304595](https://github.com/tikoci/centrs/issues/185#issuecomment-5048304595) |
| **Q11** native-api readout | the cell is **not** degraded — `:put [:parse …]` over native `/execute` with `as-string` returns line/column; the old console-only caveat is retired | [#5046924529](https://github.com/tikoci/centrs/issues/185#issuecomment-5046924529) |
| **Q17** robustness | product parser bounds nesting depth (over-depth diagnostic) and scans single-pass; determinism + well-formed span trees are property tests | [#5040370326](https://github.com/tikoci/centrs/issues/185#issuecomment-5040370326) |

**Pre-registered thresholds — outcomes:** `api-candidate`/write-shape precision
and coordinate invariants met; the **one hard-0 threshold that was *not* met is
Q14's "no fabrication after the first defect"** — the throwaway lab walker
invents a command in 3 of 76 mutants, which is exactly why the fail-closed
bare-word rule (b) above is a **hard product requirement**, not a nicety. The lab
probes were left unpatched by design; the guard belongs in the product parser.

**Corpus coverage caveat (#203).** Every figure above was measured on the
913-script corpus, which is **96.8% two forum authors** (`amm0` 630,
`rextended` 254) and **53.8% scripting-directive-bearing**. Pure `add`/`set`
configuration is **2.3%** (21 files), genuine device-emitted `/export` output
is **1.0%** (9 files), and the three `/export` serializations — `compact`,
`terse`, `verbose` — were never captured at phase 0. Nearly every file also
opens with a harness-injected `# Source: …` line the device never wrote (884
of 913). The ratified answers hold for what was measured; they are **not**
evidence of coverage over device configuration, which is the genre most likely
to be handed to `explain` and the one that concentrates Q4 path context and
Q6's bare-path ambiguity. Quote phase-0 numbers per genre, never as one blended
figure. #203 tracks the capture and the re-score.

Those figures are re-derivable, not eyeballed: `bun run explain:corpus-census`
(`scripts/explain-corpus-census.ts`) reproduces the whole genre table from
`corpus.sqlite`, with a per-collection stratum breakdown, and is the source of
truth over #203's prose where the two disagree — it corrects the issue's
export-banner count (9, not 8: the issue's own 22 − 13 shebangs) and its
pure-config count (21, not 23: the first pass counted MAC addresses, IPv6
literals, and DHCP client-ids as `:` directives, which under-counts exactly the
config genre in question). Since phase 0 the corpus has grown to 948 with a
`tangentsoft` stratum of 35 genuine `/export … terse` device captures, taking
export-banner share to 4.6%; **that stratum is not part of any phase-0 figure
above**, and no promoted module has been scored against it yet (#203
deliverable 2).

The corpus itself is not in this repo and is not moving here — `lsp-routeros-ts`
owns producing snapshots, centrs owns which snapshot it measures against.
`scripts/corpus-pin.json` is that second half: the commit and the blob sha256 a
census run measures. It identifies the **current** 948-script snapshot only —
the phase-0 figures above were measured on the frozen 913-script corpus and no
pin describes them. `bun run corpus:fetch` downloads and verifies it, so the
censuses run from a bare clone and in CI rather than on one machine (#186).

**All three export serializations parse clean offline (#203 deliverable 2,
re-scored after #207).** Every one of the 120 CHR captures — `compact`, `terse`
and `verbose` × `hide-sensitive` / `show-sensitive` × both pinned versions —
runs through the promoted modules with **zero segmenter structural notes, 100%
Q4 path resolution, and 0.0% Q16 abstention with no blockers anywhere in the
stratum**. The last figure is new: before #207's baked menu table, the
`isConfirmedNav` hyphen rule abstained on 25 distinct genuine menus. This is
the coverage claim that matters for `explain`, and it holds.

**Q6's bare-path abstention is closed on the same table (#210).** `verbsplit.ts`
originally did not consume `menus.ts`, so Q6 kept returning `ambiguous` on
`compact`/`verbose` for exactly the bare-path lines the container table can
decide. It now reads that table at V4 — the one case the ratified `proposed`
rule refuses — and emits a `navigation` resolution when the path is a known
menu. Abstention on device-emitted export goes to **0.0% on every stratum**
(from 37.6–38.4% on `compact`/`verbose`; `terse` was already 0% by
construction, since it never emits a bare menu line), and on the frozen corpus
from 4.0% → **1.4%** dev and 1.2% → **0.5%** holdout.

The table is consulted in `resolveVerb`, never in `splitRun`, so the ratified
schema-free rule still prices decision 3 on its own terms and Q16's abstention
is unchanged to the decimal (44.8% dev / 46.0% holdout). Precision was checked
against the device parser rather than asserted: over 1,689 IL (`:parse`)
projections — which distinguish `menuctx` from `cmd` natively — the table never
calls a menu what the device read as a command, neither across the whole table
nor across the 104 paths this rule flips. The residual is the right residual:
`/system/reboot`, `/quit`, `/tool/speed-test` and abbreviated forms like
`/ip fire conn` stay `ambiguous`, because the table is a floor and absence from
it is not evidence of a command. *(#228 has since decided all but the
abbreviated forms — see below.)*

**The contradicting half of that seam is closed too (#211 B1).**
`pathresolve.ts` claimed **every** `/`-led bare path was navigation, with no
check that the path is a menu, so `/ip address print` navigated to the
non-existent `/ip/address/print` while `verbsplit` read the identical text as
verb `print` at `/ip/address` — two promoted modules, contradictory answers,
34 dev / 13 holdout statements, `verbsplit` right in every one. `menuNavPath`
now consults the same frozen `VERBS` set (R9), which takes those statements to
**0 dev / 0 holdout** at no abstention cost: they were already decided, just
decided wrongly. The vocabulary moved to the leaf `verbs.ts` so both modules
share one object and cannot drift apart, and the invariant — a
`verbsplit`-`resolved` statement is never `isNav` — is pinned in
`test/unit/explain-pathresolve.test.ts` alongside R9's premise: no path in the
generated `MENU_PATHS` table carries a verb segment. That premise is scoped to
the table, not to RouterOS — `menus.ts` is a floor, so it cannot rule out an
unlisted menu named `.../print`, which R9 would read as a command.

R9 left the harder half open (**#211 B2**): a bare path with *no* verb
(`/system/reboot`, `/quit`, `/terminal/cuu`) was still read as navigation and
still cascaded, because the menu table is a floor and absence from it is not
evidence of a command. B2 was parked rather than guessed at for exactly that
reason — the only rule available would have had to invert the floor contract.

**#228 closes B2 for the published subset, without touching the floor.** The
command axis is the missing *positive* evidence, so R12 refuses navigation into
a path a table SAYS is a command rather than into one another table happens not
to mention. `/system/reboot` no longer moves the context, so a statement after
it resolves where it actually is; `verbsplit` and `pathresolve` agree, which
they would otherwise now do *confidently* in opposite directions. What is left
is the honest residue of both floors — `/terminal/cuu` is a real no-argument
command MikroTik publishes nowhere — and it stays pinned as a KNOWN LIMIT
fixture rather than assumed closed. The contradiction that #202 would have
rendered is gone.

**The command axis also outranks the punctuation guess.** `splitRun`'s last
rule reads the first space-separated token as the verb, which lands on the
operand whenever the command itself was written slash-joined:
`/system/gps/monitor once` put the verb on `once`, and
`/interface ethernet reset-counters ether1` on `ethernet`. A published command
names its own boundary, so the operand goes back to being an argument and
`argsAt` moves with it. Over the frozen corpus plus the export stratum, 171 of
19,002 statement readings change and every one names a better token; Q16
abstention moves 44.8% → **44.6%** dev, 46.0% holdout and 0.0% export unchanged,
and exactly one document changes verdict (`unknown` → `false`, a pasted
`/system/gps/monitor once` transcript — an abstention #207 recorded as correct
*given no evidence*, which there now is). The command axis says which token is
the verb; it says nothing about whether that verb mutates, so `write.ts`'s
curated vocabularies are unchanged and `/system/reboot` still abstains.

`splitRun` itself is untouched again — both tables are consumed by the callers —
so the ratified schema-free rule keeps pricing decision 3 on its own terms. Two
places deliberately do *not* consult the catalog: scripting directives, where
R10 was measured 2,088-to-18 and the seven root-level catalog commands all sit
where R10 already puts them; and a bare-word head at the ROOT context, because
those seven are ordinary English words and the corpus's pasted `import serial` /
`import io` / `import os` would otherwise read as RouterOS `/import`. An
*inherited* menu context is itself the evidence that the surrounding text is
RouterOS, so a relative `stop [find …]` under `/container` does resolve.

**Importability was also measured, and is a weaker, narrower result than it
first appears (#203 deliverable 4).** On CHR, none of the six root `/export`
documents imports into a blank same-version CHR; per-menu exports do, and
round-trip byte-exactly including continuation-wrapped comments. RouterOS
`/import` is fail-fast, so it aborts at the first error and every later
statement silently never runs. But **all four failure causes are semantic or
device-state rejections, not syntax**: a duplicate object, a built-in object,
a missing mandatory value, and a name collision. That was verified rather than
assumed — each blocker statement was replayed through `:put [:parse …]` and
`/console/inspect request=highlight` on both versions and **accepted every
time**, with controls (`no-such-attr=`, an unterminated string, a nonexistent
menu) correctly rejected. So these results carry **no** implication about
whether `explain` can parse the forms, and they do not license claims about the
export styles in general: the captures come from one synthetic configuration on
CHR, which has a single NIC and no switch or wireless hardware, so its defconf
and its available menus differ from any real device's. Treat the provenance
label as **L1-emitted, L2-refuted for these captures on CHR**. Harness and
per-document results: `.scratch/explain-lab-q203-import-verify.ts`;
validity check: `.scratch/q203-blocker-validity.ts`.

**Non-blocking / deferred (not ratification-gating):** Q5 expression depth, Q7
tokenizer corners, Q9 potential-command taxonomy, Q12 span-vocabulary draft —
these refine the surface during implementation but did not gate ratification.
They keep their homes in staging: **Q7** is now concrete as #201 (lexical
boundaries — sigil spellings, escape validity, statement-start eligibility)
and #199 (the shared scanner's `$[…]`-in-string blind spot), both raised by the
Q13 promotion and both spanning already-promoted modules; **Q5** and **Q9** are
phase-1 measurements; **Q12** is spec open item 2 and hardens through #264
B4/B5 with the offline consumer check. The
probe framework's disposition (reuse of the mutation suite, coordinate
fixtures, and adversarial generators as product test fixtures) is tracked in
issue #186 rather than carried into mainline.

## Definition of done and staging

Verification follows the [constitution](../../docs/CONSTITUTION.md#done-definition).
The phase-0 grounding and promoted phase-1 CLI/library core (#185/#202) are
already in the product. The remaining task graph is maintained in #90; issue
closure for an earlier slice does not establish the baseline below.

### Offline baseline acceptance

The offline capability can advance from `coded` to `verified` when:

- **Examples and diagnostics:** the offline examples and focused analysis/CLI
  contract tests pass. Known false confident readings in the baseline task
  list, starting with #311's missing separator, are fixed with source-located
  diagnostics and accepted/malformed controls. Unknown or ambiguous input
  remains explicit; no fabricated statements, paths, values, or runtime acceptance.
- **Bounded execution:** the existing public `explainCommand` performance,
  coordinate, depth, no-throw, and determinism contracts pass. A reproduced
  performance failure is investigated before changing its threshold (#313). Cost
  must grow with input size and no faster: a wall-clock budget on a thermally
  throttled machine measures the machine, so the growth **shape** is pinned by a
  ratio between two sizes timed back to back, and an absolute threshold is never
  raised in place of finding the growing term. One input shape is not enough —
  #313's separator-free input carries no symbols, so it never reaches the
  symbol/value machinery where the next growth term was hiding (#317), and
  neither of those carries a `do={…}`, which is where the third one was (#320).
  A guarded shape is only guarded for the analyzers it actually runs, so a new
  growth guard states which analyzers its input reaches and is mutation-tested
  against the term it removed.
- **Measured token surface:** the total, gapless `--tokens` partition and
  generated censuses remain reproducible; #264 B4 / #263's projection and
  device-agreement report are in
  [Device agreement](#device-agreement-for-the-token-partition-264-b4-263),
  re-derivable without a router or the corpus. Report decided errors,
  abstentions, version/state differences, and corpus bias separately — the
  report's outcome buckets and its four applicability categories are that
  separation. Classified-byte percentage is not syntax coverage, and agreement
  is a trend, not a new numerical pass gate. A token-level rule and a token fill
  read the skip-tolerant argument stream, never the strict REST reading (#316);
  the two share one boundary walk, the strict reading's reach is unchanged, and
  the skip-vs-prefix fork is priced rather than assumed —
  [The token stream a rule reads](#the-token-stream-a-rule-reads-316). That
  stream reaches the envelope as the token partition and nowhere else, which is
  what makes the `=` boundary visible to a consumer whose statement published
  no arguments at all (#264 B5).
- **Usable library contract:** one bounded browser/editor consumer imports a
  documented public offline entry point, runs analysis without transport/CDB
  dependencies, and verifies structure, diagnostics, tokens, and source-position
  mapping against the CLI/library result (#312). **Met** by `@tikoci/centrs/explain` and
  `bun run explain:browser-consumer` — see
  [The offline package entry](#the-offline-package-entry-312); the boundary is a
  module-graph gate and the consumer proof executes the browser bundle rather
  than only compiling it. The token vocabulary that consumer reads is settled by
  #264 B5 — [The vocabulary](#the-vocabulary-and-what-earns-a-class-264-b5) —
  on a stated rule, with the merges it keeps and the one split it admits but
  does not make each recorded there. A complete editor, LSP server, palette
  reproduction, or SCIP implementation is not required to prove this contract.
- **Reachable evidence and explicit residue:** changed RouterOS semantic claims
  have committed CHR-grounded controls and a reproducible capture/replay path.
  Every remaining issue has a stated scope and dependency; #225 distinguishes
  offline value work from live types, #272 owns evidence reachability, and #211's
  unlisted-path decision retains the current abstention until separately decided.

Retain the existing checks: `bun run lint`, `bun run test`, `bun run build`, and
`bun run lint:ci`, plus the affected CHR grounding/integration procedure from
the constitution. Add the consumer and agreement checks with their implementation.
No new rules engine, schema snapshot, final-state interpreter, or network-behavior
test framework is part of this baseline.

### Following capabilities

- **Live probes (#236, phase 2):** highlight + `:parse` and
  completion/child/syntax over rest-api/native-api. B4's projection/agreement
  informs this work; each live cell requires its own CHR-passing examples.
- **MCP alignment (#223):** the deliberate flat-to-rich response migration,
  coordinated with rosetta. Independent of the offline token vocabulary.
- **Facet polish (phase 3):** live sizing, `--full`, completion/schema ergonomics.
- **Full LSP integration (phase 4):** consume live and offline results in
  `lsp-routeros-ts`, building on the earlier offline consumer check.

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
  *Amended 2026-08-07 (#228).* The rejected candidate was the
  restraml/deep-inspect command tree: indirect, version-shaped schema data with
  substantial churn, and that reasoning still holds for it. The carve-out is
  narrower: offline ships **no schema** — no argument names, no types, no enums,
  no per-menu verb lists, no `.proplist` — but it does ship a generated
  **structure** table (path, kind, provenance, published applicability gate)
  unioned from pinned RouterOS inspect trees and MikroTik's published CLI
  Reference. Such a table may say whether a path is navigation or a command; it
  never describes what a command accepts, and absence from it abstains and never
  rejects. `src/explain/catalog.ts` is that table. Its **command axis is read**
  by `pathresolve.ts`, `verbsplit.ts` and `write.ts`. *Amended again by #235:*
  its **menu/settings kind is read too**, unioned with `menus.ts` — decisive for
  a relative bare path once its inherited context is applied, and for the
  absolute bare path `verbsplit.ts` used to call `ambiguous`. Presence still
  decides in one direction only; absence still abstains. It is still a static
  snapshot of vendor-published structure, which is why the decision is amended
  rather than argued around.
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
- **`:parse` readout is transport-specific** (constitution); native API uses
  `/execute as-string` and returns the same parser text as REST/console, while
  omitting `as-string` returns only the job handle (Q11).
- **MCP shape change is a deliberate pre-1.0 break**, migrated in one change.

Still open (implementation opens — none block ratification):

1. Final flag names (`--full`, `--curl`, facet names) and the smart-sizing
   thresholds (what counts as "cheap", what triggers truncation).
2. The centrs span vocabulary itself: class list, mapping table from RouterOS
   highlight classes (and their colors), and how unknown/new upstream classes
   degrade. Phase 0 pinned the raw inputs (Q13's per-occurrence highlight-class
   corpus; the observed 19 classes on 7.23.2 plus drift on 7.24rc2) but the
   centrs-owned class list and color map are a **draft** (lab question Q12,
   non-ratification-gating); the offline vocabulary hardens through #264 B4/B5
   and the offline consumer check. Live mappings and full LSP integration
   follow separately.
3. Whether the live describe ladder needs result caching per target+version
   (probe cost vs freshness) — deferred to implementation evidence.

Resolved during phase 0:

- **First CLI→REST families (Q8).** Nine mapping rules are
   runtime-exercised (2xx on 7.23.2 and 7.24rc2): `add`→`PUT`, `print`→`GET`,
   `get`→`GET/<id>`, `set`→`PATCH/<id>`, `remove`→`DELETE/<id>`,
   `run(action)`→`POST/<path>/<command>` (demonstrated by `/ip/dns/cache flush`
   with an empty body, and read as the family it names, not as the one verb),
   and `proplist`/`query`→`POST/<path>/print`. Selector
   writes (`set`/`remove [find …]`), singleton-menu `set`, and non-CRUD actions
   fail closed to `execute`/`unknown` (no `curl`). Placeholder-host and
   credential-elision rendering details stay an implementation open; `curl` is
   REST-only (native-api has no curl analogue).
- **Ratification question list (#185).** The phase-0 question list and the spec
  claims each gated were the deliverable of #185; every ratification-gating
  question is answered.
