# explain — examples

Each numbered example is an executable spec. Once `explain` is implemented,
offline examples run under `test/unit/explain.test.ts` and live examples under
`test/integration/explain.test.ts` (rest-api) and
`test/integration/native-api-explain.test.ts` (native-api) against a CHR booted by
`@tikoci/quickchr` — one assertion per example (example N ↔ assertion N).
The offline examples (1b, 3, 4, 4b, 5, 17, 18, 18b, 20, 21, 22) are **green**
as of #202b; 1, 2, 6 and 23 assert `transport`/`--curl` and are #202c's. The
live examples are still the **target**: those cells are `designed`, and flag and
field names track the ratified surface in `README.md`.

A letter-suffixed example (`1b`, `4b`, `18b`) is the **counterpart** of the number it
follows: the same question with the other answer, added where implementing the
spec showed that one example was carrying two contradictory readings. It gets its
own assertion (`1b` ↔ assertion `1b`); the numbering never renumbers, because
these numbers are cited from issues and commit messages.

`$R` is `<host>:<rest-port>` resolved by quickchr; `$A` is `<host>` and
`$API_PORT` is the native API port (`chr.ports.api`); `$U` / `$P` are CHR
credentials from the harness. Live examples are **target-first**
(`explain <router> '<input>'`); RouterOS input is single-quoted so the shell
never expands `$vars` or splits on `>`. Envelope-asserting examples pass
`--json`; live examples ride **rest-api** unless they explicitly pin
`--via native-api`.

## Offline (no router, no CDB — canonicalizer only)

### 1. Canonical form, write shape, and transport

```bash
centrs explain '/ip/route/add dst-address=10.9.0.0/16 gateway=192.0.2.1' --json
```

`ok: true`; `data.canonical` is
`{ path: "/ip/route", verb: "add", mode: "structured", writeShaped: true }`
with the args split out; `data.structure.statements[0].resolution` is
`"resolved"` and its `transport.classification` is `"api-candidate"` (the
statement is covered by a tested REST mapping rule); `data.verdict` is `pass`;
exit `0`.

**The verb must be IN the path for `mode` to be `structured`.** This example
originally spelled the input `/ip/route add …`, which the execute gate reads as
`script` — `add` is a bare token with no `=`, and widening the gate to accept it
is a product regression (`docs/CONSTITUTION.md`). `data.canonical` reproduces
that gate verbatim, so the example uses the spelling that is actually
structured. The space spelling is example 1b.

### 1b. The CLI spelling is script to the gate and a command to the analysis

```bash
centrs explain '/ip/route add dst-address=10.9.0.0/16 gateway=192.0.2.1' --json
```

`data.canonical.mode` is `"script"` and `writeShaped` is `false` — the gate's
answer to "may this be sent as a structured REST call". Beside it,
`data.structure.statements[0].command` is `{ path: "/ip/route", verb: "add" }`
and `data.structure.containsWrite` is `true`: the analysis answers "what did the
human write", and the two questions have different answers over the same bytes.
Neither is wrong and the gate is never widened by the analysis.

### 2. Script mode is reported, not widened — and routes to execute

```bash
centrs explain ':foreach i in=[/ip/address find] do={ :put $i }' --json
```

`data.canonical.mode` is `"script"` and `writeShaped` reflects the gate's
conservative verdict — the same answer `execute` would act on.
Each resolved command under `data.structure.statements[]` classifies
`"execute"` with the `centrs execute` invocation rendered, so the right runner
surfaces even for script input.

### 3. Sub-command paths are re-constituted; the gate verdict is untouched

```bash
centrs explain '/ip/address remove [find comment=defconf]' --json
```

`data.canonical` matches `canonicalizeExecuteCommand` exactly as its anchor
tests pin it: `mode: "script"`, `writeShaped: false` (a bracketed sub-command
selector is never write-shaped structured). The richer inference lives beside
it: `data.structure.subcommands` exposes the inner command with its resolved
enclosing path `{ path: "/ip/address", verb: "find" }` plus its span, and
`data.structure.containsWrite` is `true` (basis `heuristic` in the referenced
evidence entry) because of the outer `remove`.

### 4. Same token, different role: `comment` as verb vs argument

```bash
centrs explain '/ip/address/comment numbers=0 comment=uplink' --json
```

`data.canonical.verb` is `"comment"` — at this position `comment` is the
RouterOS *verb* — while `data.canonical.args` carries the `comment` *argument*
with its value. The two roles of the same word are distinguished by position,
and both facts cite canonicalizer evidence (offline heuristics; live
completion is the authority — see examples 13–15).

**The verb must be IN the path here too**, for the same reason as example 1:
this example originally spelled the input `/ip/address comment …`, which the
gate reads as `script` with an empty `path`/`verb`/`args`, so neither role was
visible in `canonical` at all. The two-role contrast is a claim about the
gate's split, so the example uses the spelling the gate splits. The space
spelling is example 4b.

### 4b. The space spelling keeps both roles in the analysis, and neither in the gate

```bash
centrs explain '/ip/address comment numbers=0 comment=uplink' --json
```

`data.canonical.mode` is `"script"` with `verb: ""` and `args: {}` — the gate
declines the whole input, so it distinguishes no roles at all.
`data.structure.statements[0].command` is
`{ path: "/ip/address", verb: "comment", args: { numbers: "0", comment: "uplink" } }`:
the analysis reads the verb role from either spelling, and since #202c it reads
the *argument* role here too. Both roles of the same word, from bytes the gate
declined — which is the clearest statement of why the two surfaces are separate.

### 5. Offline is honest about what it cannot know

```bash
centrs explain '/ip/address print' --schema --json
```

No router was named, so no enumeration is fabricated: `data.schema` is absent
(or empty with `truncated: false`), every emitted fact cites `canonicalizer`
evidence, and a tip states that richer schema/completion data is available
when a router is provided.

### 6. curl rendering with a placeholder host

```bash
centrs explain '/ip/address print' --curl --json
```

The first statement's `transport.rest` carries the method +
`/rest/ip/address` mapping and its `transport.curl` renders a ready-to-edit
`curl` command using a placeholder host (no router was given) and elided
credentials; the equivalent `centrs api` invocation is rendered alongside. A
statement *not* covered by a tested mapping rule classifies `"unknown"` and
renders no curl.

## Live (CHR target, rest-api)

### 7. Describe a path: verbs first

```bash
centrs explain $R /ip/address -u $U -p $P --schema --json
```

`data.schema.verbs` lists the verbs available at `/ip/address` (`add`, `set`,
`remove`, `print`, …), each with an arg count or a drill-down hint rather than
the full arg expansion; facts cite `live-inspect` evidence stamped with the
CHR's RouterOS version.

### 8. Describe a verb: its arguments

```bash
centrs explain $R /ip/address/set -u $U -p $P --schema --json
```

`data.schema` enumerates the settable arguments of `set` (`address`,
`interface`, `disabled`, …) with types where the device reports them.

### 9. Describe print: the proplist special case

```bash
centrs explain $R /ip/address/print -u $U -p $P --schema --json
```

`data.schema` returns the `.proplist` value set — what the output *can*
contain — rather than treating `print` like a plain verb. The grounded probe is
`completion input="/ip/address/print proplist="` (dot-free console spelling),
filtered to rows with `show=true`; each returned fact cites that live evidence.

### 10. Smart sizing truncates with counts, `--full` lifts it

```bash
centrs explain $R /ip -u $U -p $P --schema --json
```

The `/ip` subtree is large: `data.schema.truncated` is `true`, counts are
reported in place of the full expansion, and a warning/hint names the
narrower query (or `--full`) that expands it.

### 11. Spans and the error byte (centrs vocabulary)

```bash
centrs explain $R '/ip/address add address=bogus interface=' -u $U -p $P --json
```

`data.spans` classify the input byte-by-byte using the **centrs** span
vocabulary (not raw RouterOS highlight classes); the first hard error's byte
offset appears in a diagnostic citing `live-inspect` evidence.

### 12. Structure via :parse

```bash
centrs explain $R ':if (1 > 2) do={ :put x' -u $U -p $P --json
```

The unclosed block yields a `:parse`-derived diagnostic; no partial structure
is fabricated past the first hard error. The line/column detail is asserted
here over rest-api; example 24 asserts the same readout over native API using
`/execute as-string`.

### 13. Completion: partial argument name

```bash
centrs explain $R '/ip/address add comm' -u $U -p $P --complete --json
```

`data.completion` includes `comment` as a completing candidate for the
partial word `comm` — a valid partial, no unknown-word diagnostic.

### 14. Completion: complete argument name, no value yet

```bash
centrs explain $R '/ip/address add comment' -u $U -p $P --complete --json
```

The candidate set marks `comment` as a complete argument name expecting a
value (`=` continuation) — distinct from example 13's partial match and from
an unknown word.

### 15. Completion: value position

```bash
centrs explain $R '/ip/firewall/filter add chain=' -u $U -p $P --complete --json
```

With the input ending in `=`, candidates are **values** for `chain`
(`forward`, `input`, `output` — labeled as observed, never a closed set). For
a free-form argument like `comment=`, the same probe yields type info (string)
rather than candidates.

### 16. Runtime acceptance is never claimed

```bash
centrs explain $R '/ip/route add dst-address=10.9.0.0/16 blackhole=yes' -u $U -p $P --json
```

Even when every probe passes, `data.runtimeAcceptance` is `"not-proven"` —
the inspect-vs-runtime gap stays machine-readable.

### 17. Fan-out is rejected

```bash
centrs explain --group lab '/ip/route print' --json
```

`ok: false` with `usage/fanout-not-supported`; `explain` takes at most one
router.

## Phase-0-derived contract anchors

These examples are the product-facing subset of the phase-0 findings. The
larger mutation, coordinate, and stress matrices live as product-owned fixture
tests per README phase 0.5; no test imports `.scratch/` code.

### 18. A bare path the menu table does not know is ambiguous offline

```bash
centrs explain '/system/reboot' --json
```

The first statement has `resolution: "ambiguous"`: without a schema, the same
shape can be a menu or a no-argument command. It carries no invented `command`,
its transport classification is `"unknown"`, and a canonicalizer diagnostic
explains the menu-vs-command ambiguity. `data.verdict` remains the independent
diagnostic severity summary; it is not the statement-resolution field.

**The input changed with #207.** This example used to read `/ip/route`, from
before the baked menu table existed. `/ip/route` is one of the 615 paths that
table lists, so offline now decides it — see example 18b — and the ambiguity this
example is about needs a path the table does *not* list. `/system/reboot` is
one: a real command that is shaped exactly like a menu.

### 18b. A bare path the menu table DOES know resolves as a menu, offline

```bash
centrs explain '/ip/route' --json
```

`resolution: "resolved"` with `kind: "menu"` and `command: { path: "/ip/route" }`
— no verb, because a navigation statement names only a menu. The evidence is the
generated table (#207), not a guess about hyphens or token counts, and it is why
the export-abstention rate went to zero. Example 19 asserts the same reading
against a live device, which is a confirmation rather than a promotion.

### 19. Live evidence confirms the same bare path as a menu

```bash
centrs explain $R '/ip/route' -u $U -p $P --json
```

`/console/inspect` completion and highlight agree that the terminal token is a
`dir`; the first statement is `resolution: "resolved"`, `kind: "menu"`, and
has no runnable transport rendering. The evidence entry is version-stamped and
the probe never executes the path. Since #207 the offline reading (example 18b)
already says the same thing from the generated table, so what the live probe
adds here is **provenance and a version stamp**, not the answer — and it is the
oracle for a path the table does not list, where offline abstains (example 18).

### 20. Explain-only write detection is three-valued

```bash
centrs explain '/ip/address add address=198.51.100.10/32 interface=ether1' --json
centrs explain '/ip/address print' --json
centrs explain '/disk format-drive disk1' --json
```

`data.structure.containsWrite` is respectively `true`, `false`, and
`"unknown"`. The third result must not become `false`: `format-drive` is
write-shaped but outside the small, version-stable write table. These values do
not alter the execute gate's `canonical.writeShaped` verdict.

### 21. A defect cannot fabricate a following command

```bash
centrs explain '/interface bridge add name=br;0 protocol-mode=none' --json
```

The injected `;` has RouterOS statement-separator semantics, so the input is two
statements, not one with a corrupt value. The tail statement beginning `0`
resolves `"unknown"` — a bare-word head fails closed — with no confident `/r0`
command or runnable transport rendered, and a
`explain/canonicalizer/unresolved-statement` diagnostic carries **that
statement's** byte region. The analysis itself is `ok: true`; `data.verdict` and
`--fail-on` report the diagnostic.

**No defect region is emitted for the `;` itself.** A stray mid-token delimiter
is one of the two classes deliberately NOT detected (see *Result shape* → defect
regions, and #192): it is plausible but ungrounded, and it needs a probe matrix
before a detector is worth having. What this example pins is the fail-closed
floor that matters — corruption may degrade a reading, never invent one.

### 22. Normalization preserves device byte offsets and LSP positions

```bash
centrs explain '/system identity set name="router-🚀"' --json
```

`data.input.normalized` is `true`; the four UTF-8 bytes of `🚀` occupy four
analyzed bytes and map to its two original UTF-16 code units through
`data.input.positionMap[]`. Every span remains half-open and in bounds,
`end === input.bytes` is legal, and a cursor inside those four bytes snaps to
the character boundary rather than splitting the original character.

### 23. Selector-less set fails closed offline

```bash
centrs explain '/ip/dns set use-doh-server=https://resolver.example/dns-query' --curl --json
```

The statement's transport classification is `"unknown"` and no curl is
rendered. Offline cannot prove that `/ip/dns` is a singleton; the same shape on
an id-bearing table requires an id. Live schema evidence may lift this case to
`api-candidate`.

### 24. Native API returns the same parse diagnostic

```bash
centrs explain $A ':if (1 > 2) do={ :put x' --via native-api --port $API_PORT --username $U --password $P --json
```

`meta.via` is `native-api`; `:put [:parse …]` runs through `/execute` with
`as-string`, and the diagnostic carries the RouterOS line/column text rather
than an opaque job handle. The corresponding evidence entry names `:parse`,
is version-stamped, and no command is executed.
