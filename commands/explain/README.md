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
transport-less, and **`centrs explain '<input>'` runs today** (#202b): the row
stays `designed` because the grid tracks protocol cells and offline occupies
none. See `docs/MATRIX.md` for the row. A first design round
(2026-07-19, recorded in #90) settled the surface shape and the offline model;
the **phase-0 canonicalization grounding lab (#185) is complete and this spec
is now ratified** — every ratification-gating question was answered with cited
evidence (see [Phase-0 ratification](#phase-0-ratification-185)). The findings
folded in below; a few of them **amend** the surface (tristate `containsWrite`,
an `ambiguous` canonicalizer verdict, a defect-region diagnostics contract, a
byte-count-preserving coordinate rule, the native-api `:parse` readout). Flag
names and sizing thresholds stay provisional — those are implementation opens,
not ratification blockers.
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
  answers this one pair where it can confirm the path, so the requirement binds
  on everything the floor does *not* carry, which is most of it; the paragraph
  below that scopes it is normative, not a footnote. Four
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
  **zero kind contradictions** across 906 exactly-matching paths, three RouterOS
  versions and two architectures; 105 of the 112 published paths absent from
  every tree carry a `package`/`conditions`/`syscap` gate that predicts the
  absence. `src/explain/catalog.ts` unions the two with per-entry provenance,
  which is what keeps `menus.ts`'s device-confirmed floor intact rather than
  diluting it. The publication is not device truth: it uses the
  definition-module spelling, so `caps-man/acl/access-list` is published and
  unreachable on any device, and the hand-audited alias allowlist that recovers
  the CLI spelling is guarded by two generation-time assertions.

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
Absence from either abstains and never rejects.

- `src/explain/menus.ts` (#207) — container paths from pinned restraml
  `/console/inspect` trees. **Read today**, by `write.ts`, to confirm
  navigation.
- `src/explain/catalog.ts` (#228) — path → kind, per-entry provenance and
  MikroTik's published applicability gate, unioned from those same trees and
  CLI Reference. **Generated and committed, but read by nothing**: no analyzer
  consults it, so it changes no verdict yet. Wiring it in is a separate step,
  and when it lands a `published`-only entry is decisive for `command` and a
  tie-breaker only for `menu` — a published command misread as a menu would
  drop a write as navigation.

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
  "spans": [ { "start": 0, "end": 9, "class": "path", "ev": "e0" } ],
  "diagnostics": [],
  "evidence": [
    { "id": "e0", "source": "canonicalizer", "probe": "resolveVerbs", "basis": "heuristic", "outcome": "ok" }
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
  BOM, non-ASCII, over-depth nesting}. **Two classes named in the phase-0 draft
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
| `structure.statements[].transport` | **absent** — #202c-2, which greens examples 1, 2, 6 and 23 |
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
    result. Inside a `"…"` run the two agree and nothing is refused.
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
- **Transport is absent, not defaulted.** An `unknown` on every statement would
  read as a decision that was never made. Examples 1, 2, 6 and 23 assert
  transport and are #202c's to green; examples 1b, 3, 4, 4b, 5, 17, 18, 18b, 20,
  21 and 22 are the offline set #202b greens without it, in
  `test/unit/explain.test.ts`.
- **`spans` carries what offline can prove.** Comment runs, and the variable
  classes Q13 scored at 100% precision on resolved bindings; an abstention is
  omitted rather than rendered as a guess. The Q12 vocabulary over
  path/verb/argument bytes wants device `highlight` as its oracle. A subset is
  not a claim that the vocabulary is closed.
- **Evidence is offline-shaped, not the whole contract.** The bullet above says
  an evidence entry carries `source` (`canonicalizer` vs `live-inspect`) and a
  RouterOS version stamp; phase 1 emits neither the live source nor the stamp,
  because no probe ran and there is no device to stamp. `ExplainEvidence` is
  typed to what offline produces rather than pre-declaring variants nothing can
  emit, so phase 2 widens the union and adds the stamp — an addition, not a
  change to what a caller reads today.
- **The value TYPE axis is untouched, and `highlight` cannot close it.**
  RouterOS types values at parse time (bare `1.1.1.1` is `ip`, `3w4d8h` is
  `time`, `"1.1.1.1"` is `str`, and some commands implicitly cast) while the
  device highlighter classes every value byte `none` — so the value axis has a
  different oracle (`:parse`/IL and `:typeof`) and is **not** a subset of the
  Q12 span work above. Three facts stay separate when it lands, each with its
  own provenance and uncertainty, never collapsed into one `type` string:
  1. a **lexical shape hint** — non-authoritative and possibly *several*,
     because shapes overlap (`2.2` is number-shaped and ip-completable);
  2. the **observed type** a live IL/`:typeof` reading reports;
  3. the argument's **schema type** from path enumeration.

  The decision, the fail-closed rules (a hint is never a diagnostic; a quoted
  value never gets a "wrong type" flag) and the probe matrix that has to ground
  it are **#225**, carved out of #202's *Value-shape / typed-literal awareness*
  section so they outlive #202 closing. It sequences as the **first phase-2 lab
  round**: after #202c, because a value token cannot be annotated before the
  statement-scope lexer can locate one, and before phase-2 span/`--schema`
  emission, because retrofitting three facts onto one shipped `class` + `ev`
  would *change* a field rather than add one. Written down here because the
  lexical layer is deliberately type-blind: when a future verdict looks wrong
  around a value, that is a type-axis question before it is a lexical one.
- **Severity is fixed here, because it drives `--fail-on`.** Three buckets, and
  the split is not "structural vs not":
  - `error` — `unclosed`, `unbalanced-close`, `unterminated-string`,
    `bad-escape`, `bad-sigil`. Five classes the device itself rejects.
  - `warning` — `over-depth`, because it is centrs's own resource bound and says
    nothing about whether the input is legal; and an `ambiguous`/`unknown`
    resolution, never an error, so the default `--fail-on error` cannot fail a
    document whose only sin is being unreadable without a schema — which is most
    of RouterOS scripting.
  - `info` — `bom`/`non-ascii` (positional facts: a legal command must not
    fail), and `context-lost`, which reports a reading that is correct while the
    document's menu context was already gone.

### Designed, not implemented (the CLI surface, #202b)

`src/cli/explain.ts` ships the offline command; implemented flags are generated
into [`docs/CLI.md`](../../docs/CLI.md) and are not restated here. What the
[Surface](#surface-option-a--decided) table above describes and the command does
**not** yet accept:

| Flag / form | Phase | Why it is not accepted yet |
| ----------- | ----- | -------------------------- |
| `explain <router> '<input>'` | 2 | The grammar is parsed and **refused** with `usage/not-implemented`, naming the router it did not contact. Running the offline analysis under an invocation that asked for probes would report `mode: "offline"` about a request for more. |
| `--curl` | #202c | Nothing in `src/explain/` does REST mapping today; the nine runtime-exercised Q8 rules are that PR's work. |
| `--cursor <byte>` | 2 | It positions `--complete`, which enumerates nothing offline. A cursor with no candidate surface to position is a flag with no effect. |
| `--full` | 3 | It lifts smart-sizing limits, and the offline result is never truncated (`input.truncated` is always `false`). Same rule: no accepted flag is a no-op. |

`--complete` and `--schema` **are** accepted, because they have an offline
behavior the spec names: they enumerate nothing and emit the live-target tip.
That is the difference — an accepted flag must do something observable.

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
  no dual-shape compatibility layer is planned. **That supersession is held out
  of #202 and tracked in #223** (maintainer decision): `centrs_explain` and
  rosetta's tool surface must stay aligned for agent usage, which is a
  cross-project decision. Until #223 lands the MCP keeps its flat shape, so the
  CLI's `--json` and the MCP's `data` are **deliberately divergent**.
- Library: `explainCommand(input)` is the offline analysis (`src/explain.ts`,
  #202a) and `explainEnvelope(input)` wraps it in the standard envelope. The
  live form takes a second argument — `explainCommand(input, { target, facets })`
  — which is phase 2; it is deliberately not an options bag that accepts
  nothing today, since a caller cannot tell an ignored option from an honored
  one. `lsp-routeros-ts` and
  tikbook are the intended external consumers (hover/diagnostics/completion/
  semantic tokens over these calls); an LSP *protocol* surface on centrs
  stays out of scope (#90) — but the export shape is validated against a real
  LSP consumption spike before it hardens (staging phase 4).

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
it is not evidence of a command.

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

R9 leaves the harder half open (**#211 B2**): a bare path with *no* verb
(`/system/reboot`, `/quit`, `/terminal/cuu`) is still read as navigation and
still cascades, because the table is a floor and absence from it is not
evidence of a command. The remaining fabrication is pinned as a KNOWN LIMIT
fixture rather than assumed closed. The contradiction that #202 would have
rendered is gone.

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
phase-1 measurements; **Q12** is spec open item 2 and hardens in phase 4. The
probe framework's disposition (reuse of the mutation suite, coordinate
fixtures, and adversarial generators as product test fixtures) is tracked in
issue #186 rather than carried into mainline.

## Definition of done and staging

`designed` on the strength of this README. When implementation starts, offline
examples gate via unit/fixture tests and each live cell advances to
`CHR-passed` only when its `examples.md` entries run green via
`bun run test:integration` (constitution: done definition). Suggested staging
(sequence, not schedule):

- **Phase 0 — canonicalization grounding lab — COMPLETE (#185).** Experiments (corpus +
   CHR cross-checks against `:parse`/highlight) established what offline parsing
   can actually achieve: statement segmentation, block/scope resolution,
   sub-command path re-constitution, stateful-per-document path context, symbol
   scope, transport classification, write-shape, malformed-input recovery,
   coordinates, and stress invariants. Every ratification-gating question was
   answered with cited evidence; the findings are folded into the surface above
   and summarized in [Phase-0 ratification](#phase-0-ratification-185). This
   spec is ratified on that basis.
- **Phase 0.5 — product contract fixtures — SUBSTANTIALLY COMPLETE (#186).**
   Promote a minimal, reviewed subset of the lab into product-owned tests; do
   not import or execute `.scratch/` code. One vertical-slice PR per lab suite,
   each landing an exported module under `src/explain/` plus frozen fixtures
   under `test/fixtures/explain/`. Shipped: Q15 coordinates (#188 →
   `coordinates.ts`), Q1 segmentation (#189 → `segment.ts`), Q2–Q4 path
   resolution (#191 → `pathresolve.ts`), Q17 single-pass container walker
   (#194 → `blocks.ts`, closing #190), Q6 verb/menu boundary (#193 →
   `verbsplit.ts`), Q16 write-shape tristate (#195 → `write.ts`), Q14 cascade /
   context-certainty (#197), Q13 symbol scope (#200 → `symbols.ts`). These pin
   the ratified thresholds: no confident command invented after a defect, zero
   false negatives on statically obvious writes, 100% coordinate invariants,
   deterministic/well-formed spans, bounded depth, no throw, and roughly linear
   scaling. **Remaining:** #192 (Q14 defect-*region* spans and the
   `ambiguous`/`unknown` verdict vocabulary — the verdict half wants the phase-1
   envelope). The 76-file lab framework and its large raw streams stay out of
   mainline; #186 tracks the residual `.scratch/` disposition.
- **Phase 1 — offline core** — the grown canonicalizer: structure + gate
   verdict + per-statement resolution and transport classification +
   diagnostics (+ `--curl` rendering), and the CLI/MCP surface over it. Phase
   0.5 shipped the analysis modules as library exports only; phase 1 composes
   them behind one entry point, adds the envelope and `src/cli/explain.ts`, and
   turns `examples.md` green. **Landing in four PRs:** #192a defect regions
   (#222), #202a composition + envelope (#224), **#202b the CLI surface + the
   offline examples**, then #202c transport classification + `--curl`, which
   closes #202. Carried in with it: the lexical-boundary
   hardening (#201) and the shared-scanner substitution blind spot (#199), both
   found during Q13 and both spanning modules already promoted; plus the
   deferred lab questions Q5 (expression depth) and Q9 (potential-command
   taxonomy), which become focused tests as this surface hardens.
- **Phase 2 — live probes** — highlight + `:parse` (+
   completion/child/syntax facets) over rest-api/native-api with the safety rules
   above, including the
   broad-query describe ladder, smart sizing, and CHR-backed anchors for Q6,
   Q8, Q10, and Q11.
- **Phase 3 — facet polish** — `--complete`/`--schema` ergonomics, truncation
   counts/hints, `--full`.
- **Phase 4 — library/LSP alignment** — export shape hardened against a real
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
  *Amended 2026-08-07 (#228).* The rejected candidate was the
  restraml/deep-inspect command tree: indirect, version-shaped schema data with
  substantial churn, and that reasoning still holds for it. The carve-out is
  narrower: offline ships **no schema** — no argument names, no types, no enums,
  no per-menu verb lists, no `.proplist` — but it does ship a generated
  **structure** table (path, kind, provenance, published applicability gate)
  unioned from pinned RouterOS inspect trees and MikroTik's published CLI
  Reference. Such a table may say whether a path is navigation or a command; it
  never describes what a command accepts, absence from it abstains and never
  rejects, and a `published`-only entry is never decisive for navigation.
  `src/explain/catalog.ts` is that table, and it is **committed but unread** —
  it decides nothing until an analyzer consults it, which is a separate step.
  It is still a static snapshot of vendor-published structure, which is why the
  decision is amended rather than argued around.
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
   non-ratification-gating); they harden in staging phase 4 against the real
   lsp-routeros-ts consumption spike.
3. Whether the live describe ladder needs result caching per target+version
   (probe cost vs freshness) — deferred to implementation evidence.

Resolved during phase 0:

- **First CLI→REST families (Q8).** Nine mapping rules are
   runtime-exercised (2xx on 7.23.2 and 7.24rc2): `add`→`PUT`, `print`→`GET`,
   `get`→`GET/<id>`, `set`→`PATCH/<id>`, `remove`→`DELETE/<id>`,
   `run`→`POST/<command>`, and `proplist`/`query`→`POST/<path>/print`. Selector
   writes (`set`/`remove [find …]`), singleton-menu `set`, and non-CRUD actions
   fail closed to `execute`/`unknown` (no `curl`). Placeholder-host and
   credential-elision rendering details stay an implementation open; `curl` is
   REST-only (native-api has no curl analogue).
- **Ratification question list (#185).** The phase-0 question list and the spec
  claims each gated were the deliverable of #185; every ratification-gating
  question is answered.
