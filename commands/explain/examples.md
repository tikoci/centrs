# explain — examples

Each numbered example is an executable spec. Once `explain` is implemented,
offline examples run under `test/unit/explain.test.ts` and live examples under
`test/integration/explain.test.ts` (rest-api) and
`test/integration/native-api-explain.test.ts` (native-api) against a CHR booted by
`@tikoci/quickchr` — one assertion per example (example N ↔ assertion N).
The offline examples are **green** as of #202c-2, including 1, 2, 6 and 23's
`transport`/`--curl` assertions. The live examples are still the **target**:
those cells are `designed`, and flag and field names track the ratified surface
in `README.md`.

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

### 18. A bare path neither table knows is ambiguous offline

```bash
centrs explain '/disk/format-drive' --json
```

The first statement has `resolution: "ambiguous"`: without a schema, the same
shape can be a menu or a no-argument command. It carries no invented `command`,
its transport classification is `"unknown"`, and a canonicalizer diagnostic
explains the menu-vs-command ambiguity. `data.verdict` remains the independent
diagnostic severity summary; it is not the statement-resolution field.

**The input has changed twice, for the same reason each time.** It first read
`/ip/route`, from before the baked menu table existed; #207 decided that one (see
example 18b). It then read `/system/reboot`, which #228's published command axis
decides (see example 18c). Both tables are floors, so the example needs a path in
*neither*: `/disk/format-drive` is real enough to appear in the corpus, but 7.23.2
spells it `/disk format`, and MikroTik publishes no such entry.

### 18b. A bare path the menu table DOES know resolves as a menu, offline

```bash
centrs explain '/ip/route' --json
```

`resolution: "resolved"` with `kind: "menu"` and `command: { path: "/ip/route" }`
— no verb, because a navigation statement names only a menu. The evidence is the
generated table (#207), not a guess about hyphens or token counts, and it is why
the export-abstention rate went to zero. Example 19 asserts the same reading
against a live device, which is a confirmation rather than a promotion.

### 18c. A bare path the COMMAND axis knows resolves as a command, offline

```bash
centrs explain '/system/reboot' --json
```

`resolution: "resolved"` with `kind: "command"`, `command.path: "/system"` and
`command.verb: "reboot"` — the other half of the twin in example 18b, from the
other half of the same generated table (#228). `/system/reboot` and `/ip/address`
are the same text shape, and offline now decides both from published evidence
instead of refusing both.

`structure.containsWrite` is deliberately *not* moved by this: knowing a path is a
command says nothing about whether it mutates, so this document still reports
`"unknown"`. Examples 18d and 18e are the two things the same evidence *does*
move.

### 18d. A published command does not move the menu context

```bash
centrs explain '/ip route
/system reboot
add dst-address=8.8.8.8/32 gateway=1.1.1.1' --json
```

Three statements: `resolved`/`menu` at `/ip/route`, `resolved`/`command` at
`/system` verb `reboot`, and `resolved`/`command` at **`/ip/route`** verb `add` —
not at `/system/reboot`. A command is not navigation, so the context it does not
establish is not inherited by what follows. This was `#211 B2`, pinned as a KNOWN
LIMIT until the command axis supplied the positive evidence that a path is a
command; it is why `structure.containsWrite` is `true` here rather than describing
an `add` under a menu that does not exist.

### 18e. A published command outranks the punctuation guess

```bash
centrs explain '/system/gps/monitor once' --json
```

`command.verb: "monitor"` with `once` inside the argument list — where the
schema-free punctuation rule reads the first space-separated token as the verb and
so lands on `once`. The publication names the command, so the operand goes back to
being an operand. `structure.containsWrite` is `false`, because `monitor` is a
curated read verb; before the command axis this document abstained.

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

### 25. Offline semantic symbols retain roles and binding identity

```bash
centrs explain '{:local x 1.3; :put [:typeof $x]; :set x 2.1.1; /put $x; :local z (1.1,1::1,"abc",1d,1w7h2s,1.1.1.1/24,123,[:parse "(1+1)"],(1w+1d),2008:1::2/128,[:timestamp],"a"."b"."c",4%2,-1); :put "$[:typeof $z]"; :foreach i,v in=$z  do={:put "$i = $v; types i = $[:typeof $i], v = $[:typeof $v]"}}'
```

The text output has a `symbols:` section. The declaration, `:set` target, and
references for `x` share one result-local binding identity; `z` has another;
and the `:foreach` bindings `i` and `v` each have their own identity. Their
roles are respectively `declaration`, `assignment`, `reference`, and `binding`.
Duration literals such as `1d` and `1w7h2s` do not fabricate symbol names.

The JSON/YAML form carries the same facts under
`data.symbols.occurrences[]` as `name`, byte `span`, `class`, `role`,
`bindingIds`, `sigil`, optional `note`, and `ev`. This is the Q13 symbol view;
it does not infer value-flow types, which remain #239 S2 after #225.

### 26. Value facts keep shape, observed type, and schema type separate

```bash
centrs explain ':local x 2.2; :set x "2.2"; :local z (1,2,3); :local t 00:00:02; :local i *1; /ip/arp/add mac-address=00:11:22:33:44:55' --json
```

`data.values.occurrences[]` contains nine result-local value records — six
argument values and the three members of the array literal (example 28 owns the
interior). The bare
`2.2` carries `facts.shapeHints.values: ["ip"]` — RouterOS numbers are integers,
so a dotted decimal is an IPv4 shortcut (`2.0.0.2`) and never `num`; the quoted
`"2.2"` carries `["str"]`. The array literal, colon-form time, internal ID, and
full MAC spelling carry `["array"]`, `["time"]`, `["id"]`, and `["mac"]`.
`mac` is a schema spelling clue, not a RouterOS scripting type: the bare scalar
is `str` while the CLI Reference declares `mac-address` as `macAddr`. Each hint
fact cites canonicalizer evidence with
`basis: "heuristic"`; no record has `observedType` or `schemaType`, because
offline analysis has neither live parser output nor an argument schema. A hint
is not a diagnostic and does not change `data.verdict` or
`runtimeAcceptance: "not-proven"`.

The CHR assertion for this example also pins the boolean boundary: scalar
`true`/`false` and `yes`/`no` are `bool`, quoted forms are `str`, CLI boolean
attributes accept `yes`/`no` rather than `true`/`false`, and REST accepts JSON
booleans. These live/context observations ground the offline `bool` spelling
hint; they are not emitted as `observedType` or `schemaType` by offline explain.
The same assertion grounds the new boundaries: brace/comma literals are
`array`; colon times are `time`; `*1` is `id`; `.` concat can return `str` or
distribute over an array; `[:toarray ""]` is the only empty-array construction
and indexing it yields `nothing`; `[:parse "…"]` returns `code`; and `nil` has
no standalone offline spelling. Produced empty arrays, concat, `code`, and
`nil` remain abstentions rather than guessed hints.

### 27. Continuation comments are not REST operands

```bash
centrs explain '/ip/address/add address=1.2.3.4 \
# a note
 comment=x' --json
```

The statement's argument reading is complete: `command.args` is
`{ address: "1.2.3.4", comment: "x" }`, and `arguments.positional` is empty. Its
transport classification stays `api-candidate`, with the same two fields in the
REST body; the comment text is never rendered as an operand.

The CHR assertion grounds the wider placement rule on the requested RouterOS
channel via `/console/inspect request=highlight` plus `:parse`: unquoted `#`
inside brace arrays and parenthesized expressions is a hard error; the first
non-space `#` in `do`, `else`, `foreach do`, and `on-event` bodies that are
themselves in a statement context is a comment — the same `do={ # c` nested
inside an array is an array and `#` is an error (placement table, #249), while
a `[…]` substitution nested in that array re-enters a statement context so
`[:do { # c` is a comment again; the same lead inside a `[…]` command
substitution is a comment while `[:put #test]` keeps `#test` as a value;
attribute and bare-value `#` is content; and `#` after `}` is a hard error.
The stable/testing grounding run for #245 used RouterOS 7.23.3 and 7.24rc3;
the enclosing-array exception is grounded on CHR 7.23.3 via #249.

A same-line hash after a completed scripting directive is likewise an error:
`:local x 2 #` produces an `explain/canonicalizer/invalid-hash` diagnostic at
the hash byte and stops later semantic claims. Statement-leading comments are
listed with their byte ranges under `comments:` in the default text output.

### 28. An array literal is read member by member, and only where it is one

```bash
centrs explain ':local z {1.1;"abc";1d;{2;3};a=0x10;b=100000w}; /ip/route/add comment={1;2}' --json
```

Members of a located array literal are values in their own right.
`data.values.occurrences[]` carries one record per member, each with its own
document-byte span, its own `shapeHints`, and a `parent` naming the array's
result-local id — `1.1` is `["ip"]`, `"abc"` is `["str"]`, `1d` is `["time"]`,
the nested `{2;3}` is `["array"]` with two `["num"]` members of its own, and the
keyed member carries `name: "a"` with `["num"]` for `0x10`. `kind` is `element`,
so a caller can tell a member from a command argument without re-parsing.

**A member is not an argument value, because RouterOS does not parse it as
one.** Inside a literal the device reads an expression, so `b=100000w` hints
nothing at all: `:parse` lowers it to `$100000w`, a variable reference, because
the literal overflows the signed 64-bit nanosecond range that ends between
`15250w` and `15251w`. The same rule removes three spellings the argument
lexicon does hint — a bare word (`{abc}` is `$abc`), a full MAC
(`{00:11:22:33:44:55}` is a variable, though `:local x 00:11:22:33:44:55` is
`str`), and an internal id (`{*1}` is a hard syntax error, though `:local x *1`
is `id`) — and adds hexadecimal, which is a number here (`0x10` is 16, while
`0X10` is a variable). Expressions and substitutions abstain: `{1+1}`,
`{"a"."b"}`, `{[:parse ":put 1"]}` and `{$x}` produce no member hint.

The second statement produces **no value record** and an
`explain/canonicalizer/invalid-command-brace` error at its `{`. A `{…}` array
literal is legal only in a scripting directive's value slot:
`/console/inspect` classes
the `{` byte `error` and `:parse` refuses `/ip/route/add comment={1;2}`,
`/ip/dns/set servers={1.1.1.1;8.8.8.8}` — whose attribute really is list-typed,
which is what rules out a schema-shaped reading — `.proplist={name;comment}`,
the relative spelling `ip route add comment={1;2}`, and even
`:log info message={1;2}`. The `(1,2)` spelling is never rejected at the
delimiter in any of those positions, and a `(…)` or `[…]` around the brace
restores the expression context (`comment=({1;2})` and `comment=[:tostr {1;2}]`
both parse). The braces a
command argument does accept are script bodies (`source=`, `on-event=`), and
those are refused earlier as scope blocks rather than read as arrays.

An empty member is a device syntax error (`{;}`, `{;1}`, `{1;;2}`, `(1,)`), so
the enclosing `array` shape is withdrawn with it; a single trailing separator is
legal (`{1;}` is a one-member array). Shape hints never become diagnostics.
The command-brace error is a separate, device-grounded syntax fact rather than
an inference from the missing hint.

### 28c. Which slot the brace sits in decides whether it is an array

```bash
centrs explain ':local z {1;2}; :delay {1;2}; :for i from={1;2} to=2 do={:put 1}; :execute script={1;2}' --json
```

Only the first and third statements produce an array record. Being a scripting
directive is necessary but not sufficient: the gate is keyed on **(verb, slot)**
from a device sweep of every root builtin and every slot it completes, and a
slot has four outcomes. `:local z {…}` and `:for from={…}` EVALUATE the brace
(IL `(, 1 2)` for `{(1,2)}`), so they are arrays. `:delay {1;2}` is a syntax
error — a scalar-typed slot at the same `/` path — and produces nothing.
`:execute script={1;2}` parses but keeps the brace VERBATIM as a script
(`script=(1,2)`, not `(, 1 2)`), so it is not an array either, and neither are
the code slots `:onerror in=`, `:retry command=` and `:if do=`. The same name
can differ by verb: `:foreach i in={1;2}` is an array while
`:onerror e in={1;2}` is a program.

A positional is keyed by its index, because position decides: `:local {1;2}`
puts the literal in the NAME slot and does not parse, while `:local z {1;2}`
puts it in the VALUE slot and does. The verb is matched verbatim for the same
reason: RouterOS accepts only the lower-case spelling, so `:LOCAL z {1;2}` is
`expected command name` and gets no array, while an argument's casing is free
(`:local Z {1;2}` binds `$Z` and does). Everything the sweep could not ask is
refused, so the gate loses coverage rather than inventing a shape.

Two rejections a member walk cannot see from the outside are also refused here.
A nested literal the device rejects withdraws its container — `{(1,)}`,
`{a=(1,)}`, `{1;(2,)}`, `{()}`, `{a=()}`, `{(,)}` and `(1,(2,))` are all
`:parse` syntax errors, even though a `(…)` member is usually a group (`{(1)}`
is the one-member array `1`). And member descent stops after eight frames: past
that the interior is unverified, and a fault below the bound still makes the
whole statement a syntax error, so the literal is refused rather than called an
array on the strength of its delimiters alone.

### 28b. The comma spelling is accepted everywhere, and means two things

```bash
centrs explain '/ip/dns/set servers=1.1.1.1,8.8.8.8; /ip/route/add comment=a,b; :local x 1,2' --json
```

The brace restriction is about the brace, not about lists: `=1,2,3` is a syntax
error nowhere, and list-taking arguments really do take it. What the device does
with it depends on the argument's TYPE, which offline does not have —
`servers=1.1.1.1,8.8.8.8` lowers to `servers=1.1.1.1;8.8.8.8` and
`dst-port=80,443` to `dst-port=;80;443`, while `comment=a,b` and
`interface=ether1,ether2` keep the whole run as a single string.

So the first two records carry **`["array", "str"]`** — the first genuinely
plural hint, which is what `shapeHints.values` is a list for. Neither reading is
validated and neither becomes a diagnostic; the split is a `schemaType` fact and
that home stays empty offline. The third record, in a scripting directive's
value slot, carries `["array"]` alone: `:local x 1,2` is a two-member array on
the device and no text reading exists there.

No members are emitted for a bare comma run, because whether it splits at all is
the schema's answer. The `(1,2)` spelling is different — its delimiters prove
the array — so `servers=(1.1.1.1,8.8.8.8)` yields the array plus two `["ip"]`
members.
