# explain — examples

Each numbered example is an executable spec. Offline examples run under the
named unit/fixture suites. Live foundation examples 11, 12, 16, 24 and 48 run
under `test/integration/explain-live.test.ts`, and describe/completion examples
7–10, 13–15 and 19 under `test/integration/explain-live-facets.test.ts`, on REST
and native API with a CHR booted by `@tikoci/quickchr`. Live types 52–53 run
under `test/integration/explain-live-types.test.ts`. All of them pass on stable
7.24.5 and long-term 7.23.8, so both protocol cells are `CHR-passed` (#236).

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

`data.schema.node` is `menu`, and `data.schema.verbs` lists the verbs at
`/ip/address` (`add`, `set`, `remove`, `print`, …). Each carries its argument
count from one more `child` probe rather than the full argument expansion.
Facts cite `live-inspect` evidence stamped with the CHR's RouterOS version.

### 8. Describe a verb: its arguments

```bash
centrs explain $R /ip/address/set -u $U -p $P --schema --json
```

`data.schema.arguments` enumerates the settable arguments of `set` (`address`,
`interface`, `disabled`, …). Each has its argument-level `syntax` rows where the
device reports them (`address`: `A.B.C.D (IP address)`).

### 9. Describe print: the proplist special case

```bash
centrs explain $R /ip/address/print -u $U -p $P --schema --json
```

`data.schema.proplist` returns the `.proplist` value set — what the output
*can* contain — besides `print`'s own arguments. The grounded probe is
`completion input="/ip/address/print proplist="` (dot-free console spelling),
filtered to rows with `show=true`; it cites that live evidence. A singleton
settings menu (`/ip/dns/print`) offers no proplist names, so
`get value-name=` answers with `source: "get-value-name"`.

### 10. Smart sizing truncates with counts, `--full` lifts it

```bash
centrs explain $R /ip -u $U -p $P --schema --json
```

The `/ip` subtree is large (31 children, past the 16-probe default):
`data.schema.truncated` is `true`, the names are listed with `counts` but not
expanded, and `tip/explain-schema-truncated` names the narrower inputs in
`data.schema.next` or `--full`. With `--full`, every submenu carries its verb
and menu counts.

### 11. Spans and the error byte (centrs vocabulary)

```bash
centrs explain $R '/ip/address add address=bogus interface=' -u $U -p $P --json
```

`data.spans` includes device-derived spans in the **centrs** vocabulary,
citing `live-inspect` evidence. On CHR 7.24.5, this original example produces
no parse rejection or highlight error: `address=bogus` is not value-validated,
and the trailing empty argument is omitted from the parse output. Keep it as
a probe-limit control, not a promised syntax error.

A confirmed hard-error control is:

```bash
centrs explain $R '/ip/route add dst-address=10.9.0.0/16 blackhole=yes' -u $U -p $P --json
```

On CHR 7.24.5, highlight reports byte 47 and parse reports line 1 column 48.
The test asserts that source-located diagnostic separately from runtime
acceptance; the original input remains a control on both transports.

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

`data.completion` is `context: "argument-name"` with `comment` as a
`partial` candidate replacing bytes 16–20. No canonicalizer diagnostic calls
`comm` unknown. The device still rejects the input as written: `:parse` and
the highlight `error` both name byte 16. So pass `--fail-on never` when only
the candidates matter. `--cursor 20` gives the same answer inside a longer
input. The same candidate comes back for a relative path after `;`
(`/ip { :put 1; address add comm`), and `where comm` completes `comment` as a
`variable`.

### 14. Completion: complete argument name, no value yet

```bash
centrs explain $R '/ip/address add comment' -u $U -p $P --complete --json
```

The candidate set marks `comment` as `match: "exact"` with `takesValue: true`,
because the device offers `=` at the cursor. That is distinct from example 13's
partial match and from an unknown word. The flag `/interface print detail` is
exact with `takesValue: false`.

### 15. Completion: value position

```bash
centrs explain $R '/ip/firewall/filter add chain=' -u $U -p $P --complete --json
```

With the input ending in `=`, candidates are **values** for `chain`
(`forward`, `input`, `output` — observed from the completion probe, never a closed set). For
a free-form argument like `comment=`, the same probe yields no candidates and
`data.completion.syntax` carries `string value`. An unclosed substitution
(`:local x [/ip/address add interface=`) still completes, from the device's
own path runs.

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

The highlight classes every byte `dir`, and with `--schema` the `child` self
row says `menu`; the first statement is `resolution: "resolved"`,
`kind: "menu"`, and has no runnable transport rendering. The evidence entry is version-stamped and
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
offline analysis has neither live parser output nor an argument schema
(examples 52 and 53 are the live counterparts). A hint
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
inside brace arrays and parenthesized expressions is a hard error, except at
column 0 inside an array (example 37); the first
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

### 29. A second command-shaped run is a missing separator, not an operand

```bash
centrs explain '/ip/address add interface=ether1 /ip/route add gateway=192.168.88.1' --json
```

`data.verdict` is `fail` with one
`explain/canonicalizer/missing-statement-separator` **error** spanning the whole
second run (`[33,46)` — `/ip/route add`), whose message says to insert `;` or a
newline before it.

The source stays **one** statement: `resolution` is `"resolved"` on
`/ip/address add`, because that head really was read and the device's own
`highlight` agrees. What is withdrawn is the reading the run contradicts —
`command.args` is absent, `arguments.read` is `false`, and `transport.
classification` is `"unknown"`, so no `centrs execute` line is offered for bytes
the same result rejects. `data.values.occurrences` is cut at the same byte: it
keeps `interface` and drops `gateway`, which the device reads as the value of
`/ip/address/add`'s own `address=` rather than as an attribute name.

The rule is a known **menu path** followed by a console **verb**, never "a `/`
after the verb": `/file remove /flash/skins/foo.html` is legal and lowers to
`numbers=/flash/skins/foo.html`. It abstains on a menu path with no verb after
it and on an operand no structure table lists, both of which draw the device's
generic `bad parameter` and need per-menu positional schema to decide.

### 29b. The same commands, separated, read as two

```bash
centrs explain '/ip/address add interface=ether1; /ip/route add gateway=192.168.88.1' --json
```

`data.verdict` is `pass` with no diagnostics, two statements, and each keeps its
own `command.args`. The newline spelling is identical.

### 30. A known menu path with arguments does not get an invented verb

```bash
centrs explain '/ip/firewall/address-list name=ytkids timeout=1h' --json
```

One statement with `resolution: "ambiguous"` and no `command` at all, plus an
`explain/canonicalizer/ambiguous-statement` **warning** over the whole
statement naming both premises: `/ip/firewall/address-list` is a known menu,
and `address-list` is not a console verb. `data.verdict` is `warn`, so the
default `--fail-on error` still exits `0` — offline is saying it cannot read
this, not that RouterOS rejects it.

It used to answer `resolution: "resolved"`, `command.path: "/ip/firewall"`,
`command.verb: "address-list"` — a verb assembled out of a path segment. The
spaced spelling `/ip firewall address-list name=x` was worse, promoting
`firewall` and reporting the menu as `/ip`. Adding the verb resolves it again
(`/ip/firewall/address-list add name=ytkids` is `resolved`/`command`), and the
bare path without arguments is still `resolved`/`menu` (example 18b's rule).

### 31. A command substitution inside a string keeps its own tokens

```bash
centrs explain ':put "$[/ip address print as-value]"' --tokens --json
```

`data.structure.subcommands[0]` resolves `/ip/address` verb `print` — it always
did — and `data.tokens[]` now agrees with it: `dir` over `/ip` and `address`,
`cmd` over `print`, with the quote, the `$[`, the separators and the trailing
`as-value]"` left as `string`. The whole quoted run used to be one opaque
`string` token, so an editor rendering the partition painted a command centrs
had already read as flat text.

Byte coverage does not change — the partition is still total and gapless — only
which fill owns those bytes. The `$` sigil and the `[` / `]` delimiters stay
`string`: #264 B5 kept them there because `structure.subcommands` already
publishes the resolution and its `innerSpan` locates the brackets around it.

### 32. A block binder the envelope cannot publish is still located

```bash
centrs explain ':if ($x = 1) do={ :put "hi" }' --tokens --json
```

`data.structure.statements[0].arguments` is `{ read: false, why: "a
substitution or expression value" }` — the strict reading is all-or-nothing and
a runnable request cannot be rendered from a half-read argument list, so the
envelope publishes no `ExplainArgumentToken` here at all. `data.tokens[]` still
locates the argument: `arg` over `do`, `arg-sep` over its `=`, `brace` over the
`{`.

That is why #264 B5 gave the `=` its own class. A consumer holding only the
envelope would otherwise have to derive the name/value boundary from
`arguments[].valueSpan.start - 1`, and for 30.8% of the corpus's `=` runs —
`do=` first among them — there is no published `valueSpan` to derive it from.

The same command also shows the two `=` bytes staying apart: the one in
`($x = 1)` is a comparison and comes back `operator`, decided by fill order
rather than by a scan for the byte.

### 33. A space for the `=` is not an empty argument list

```bash
centrs explain '/ip/firewall/layer7-protocol add comment "something" regexp 1.1' --json
```

RouterOS accepts this as `comment="something" regexp=1.1`: `:parse` lowers both
spellings to the same IL, and `highlight` marks each gap `syntax-obsolete`.
Which word is an argument name is per-command schema, so offline publishes
neither reading. The statement stays `resolved` on
`/ip/firewall/layer7-protocol add`, `command.args` is absent, `arguments.read`
is `false` with a `why` naming `` `comment "something"` ``, and
`transport.classification` stays `"unknown"`.

`data.verdict` is `warn`, with one
`explain/canonicalizer/possible-spaced-argument` **warning** per pair,
spanning `comment "something"` and `regexp 1.1`. Each says to write the `=`.
The warning needs a value that cannot be a flag: `/interface set ether1 name x`
also abstains but does not warn, because `/interface print detail
without-paging` is the same shape and is two flags
(`detail=true;without-paging=true`). The `=` spelling still reads both
arguments, and a script body may drop its `=` too:
`/system/script add name=beep source { :beep }` is the `source={ :beep }` body,
not an invalid brace.

### 34. An unlisted bare path does not become a menu

```bash
centrs explain $'/terminal/cuu\nprint\nadd name=x' --json
```

`/terminal/cuu` is a no-argument command that neither the menu table nor the
command catalog lists. `/ip fire conn` has the same shape and is navigation:
RouterOS accepts abbreviated menus. CHR 7.24.5 `:parse` confirms both, so a
table miss cannot decide between a menu and a command.

The first statement stays `ambiguous`. The two after it are `unknown`
(`context lost to an earlier unreadable statement`, `contextCertain: false`),
with no `command` and no `transport`, where they used to resolve to an
invented `/terminal/cuu/print` and `/terminal/cuu/add`. On the device they are
`bad command name print` and `bad command name add` at the root.
`structure.containsWrite` is `unknown` and `data.verdict` is `warn`. A known
absolute navigation recovers the context: in
`/terminal/cuu`, `/ip address`, `print`, the last statement resolves to `print`
at `/ip/address` again.

### 35. A brace after a command is its argument, not a menu block

```bash
centrs explain '/system/script add name beep source { :beep }' --json
```

`/menu { … }` opens a menu block only when the words before the brace name a
menu. Here `add` is a command, so the brace is the value of `source` with the
`=` left out. CHR 7.22.1 and 7.24.5 `:parse` give the same IL as
`source={ :beep }`.

`data.structure.statements` has one statement, `/system/script add`, whose
span covers the whole input. `:beep` is no longer published as a second
top-level statement, which RouterOS never runs. `data.verdict` is `warn`, from
the `possible-spaced-argument` diagnostic on `source { :beep }`.

RouterOS accepts any unique prefix of an argument name. An abbreviation that
can only stand for a script-valued name keeps its body in either spelling:
`sour { :beep }`, `down-scr { :beep }` and `o={ :beep }` lower to `source=`,
`down-script=` and `on-event=` on CHR 7.24.5 and 7.23.8. Abbreviating the first
segment (`down={ :beep }` for `down-script`) is accepted on the device too, but
offline still reports `invalid-command-brace`. Every word is a prefix of some
`<word>-script`, so telling it from `comment={ :beep }` needs the command's
argument list.

A brace straight after a command is a device error, and offline now reports it.
`/system/script add { :beep }`, `/ip/route/print {1;2}` and
`/system/reboot { :beep }` each get `invalid-command-brace` and `data.verdict`
`fail`. A run that names no command still opens a block, so
`/system script { print }` is navigation to `/system/script` followed by
`print`.

### 36. A brace in a `where` clause is an array value

```bash
centrs explain '/ip address print where interface in {"ether1";"ether2"}' --json
```

A `where` clause is expression context, so the brace is the array operand of
`in`. CHR 7.24.5 and 7.23.8 `:parse` lower it to
`(in $interface ether1;ether2)`. `data.verdict` is `pass`, so `centrs execute`
runs this read. Before #502 its offline stage refused it with
`invalid-command-brace`. `data.values.occurrences` holds the array and its two
string members, the same three records as
`where interface in ("ether1","ether2")`.

The brace is also a value after `~`, `<`, `>`, `<=` and `>=`, on the left of an
operator (`where {"ether1"} in interface`), and after `!interface=` or `"a"=`.

After `<name>=`, `<name>!=` or `<name>==`, spaced or not, the device reads the
value with that property's parser and rejects the brace. Two examples are
`where interface={"ether1"}` (`expected interface value`) and
`where disabled={"y"}` (`expected yes or no`). Offline keeps
`invalid-command-brace` at the `{` there. The device does this only for a
property the menu knows: `where foo-bar={"y"}` parses. Offline cannot tell
property names apart without a per-menu list, so it reports that one too.

### 37. A column-0 `#` line inside an array is a comment

```bash
centrs explain ':local z {a=1;
# c
b=2}' --json
```

`data.verdict` is `pass`. `data.spans` holds a `comment` span over `# c`, and
`data.values.occurrences` holds the array and its two members `a` and `b`. CHR
7.24.5 and 7.22.1 `:parse` lower it to `value=a=1;b=2`. Before #503, offline
failed it with `invalid-hash` at the `#`.

The rule holds at any depth (`{a={⏎# c⏎1}}`) and in argument values
(`:foreach i in={1;⏎# c⏎2} do={:put $i}`). It needs column 0: an indented `#`
(`{a=1;⏎  # c⏎b=2}`), and one after `{`, a value or `;` on the same line, keep
`invalid-hash` at the `#`. A `#` directly inside `( … )` stays an error too. A
comment-only array, `:local z {⏎# c⏎}`, fails like `:local z {}`: both are empty
arrays, which the device rejects (#511, example 38).

### 38. An empty array value and a misplaced `;` are rejected

```bash
centrs explain ':local z {}' --json
```

`data.verdict` is `fail` with `explain/canonicalizer/empty-group` over `{}`. CHR
7.24.5 and 7.23.8 `:parse` answer `syntax error (line 1 column 12)`, the byte
after the brace. The same holds for `:put {}`, `:return {}`, `[:len {}]` and
`:foreach i in={} do={…}`. A nested `{}` (`{1;{}}`), one in parentheses
(`({})`), `where … in {}` and a body (`do={}`, `:execute {}`) parse and pass.

`:local z {1⏎;2}` fails with `misplaced-separator` at the `;`: a `;` needs an
element before it on its line. `{1;}` and `{1⏎2}` pass.

### 39. An expression with a missing operand is rejected

```bash
centrs explain ':put (1 +)' --json
```

`data.verdict` is `fail` with `explain/canonicalizer/missing-operand` at the
`+`. The device answers `syntax error (line 1 column 11)`, at the `)`. `()`
fails with `empty-group`, and `(1; 2)` and `(1⏎+ 2)` fail with
`misplaced-separator`. `(1 2)`, `(- 1)` and `(1 + -2)` pass. Inside a query,
`where (comment=+)` passes: the device reads that value with the property's
parser.

### 40. A `@` in a command word is rejected

```bash
centrs explain '[admin@MikroTik] > /ip address print' --json
```

`data.verdict` is `fail` with `explain/canonicalizer/invalid-at-sign` at the
`@`. The device answers `syntax error (line 1 column 7)`, the same byte. This
is a pasted console prompt. `:put a@b` and `comment=a@b` pass, because a `@` is
a value byte in an argument.

### 41. A named comparison brace inside a `[find where …]` is rejected

```bash
centrs explain ':put [/ip address find where interface={"x"}]' --json
```

`data.verdict` is `fail` with `explain/canonicalizer/invalid-command-brace` at
the `{`, as at the top level (example 36). The device answers
`expected interface value (line 1 column 40)`. `where (interface={"x"})` fails
the same way, and `[find where interface in {"x"}]` passes.

### 42. A stray top-level `}` ends the script, and the rest is discarded

```bash
centrs explain ':put 1};:put 2' --json
```

`data.verdict` is `warn` with `explain/canonicalizer/discarded-close` over the
`}` and everything after it. CHR 7.24.5 and 7.23.8 accept the script and lower
it to `(evl /putmessage=1)`: the device stops reading at a `}` or `]` that closes
nothing at the top level, so `:put 2` never runs and
`/system identity set name=a}` sets `a`. `data.structure` reads only the
prefix. A stray close inside an open group (`:put (1})`, `{:put 1]}`) and any
stray `)` are still rejections and still fail with `unbalanced-close`. The
execute gate refuses this warning (`commands/execute/examples.md` V9).

### 43. A variable name is letters and digits

```bash
centrs explain ':local a_b 1' --json
```

`data.verdict` is `fail` with `explain/canonicalizer/invalid-name` at the `_`.
The device answers `expected end of command (line 1 column 9)`, the same byte.
`:global`, `:set`, `:for` and `:foreach` read the name the same way, and
`:local $a` and `:local (a)` fail at their first byte. `:local "a_b"`,
`:local 1a`, `:foreach a,b in={1} do={}` and `:local name=x value=1` pass.

### 44. A `$` must start a variable

```bash
centrs explain ':put "a$ b"' --json
```

`data.verdict` is `fail` with `explain/canonicalizer/bad-string-variable` over
the `$` and the space after it. The device answers `syntax error (line 1 column 9)`, at the space. Outside
a string, `:put $_` fails with `invalid-variable` the same way. `"$v_x"` (which
is `$v` then `_x`), `"\$ x"`, `"$(1)"` and `$"a b"` pass. `"a$"` also passes,
although the device rejects it: it reads `$"` as the start of a quoted name, and
offline's string scanners end the string there, so offline abstains.

### 45. Nothing may be glued to a closed token

```bash
centrs explain ':if (true) do={:put 1}else={:put 2}' --json
```

`data.verdict` is `fail` with `explain/canonicalizer/glued-token` at the `e`.
The device answers `expected end of command (line 1 column 23)`. The same rule
rejects `:put "a"b`, `$v.b`, `(1)(2)`, `[:len a]b`, `src-address=$v/24` and a
bare word run into a `"`, `$` or bracket (`:put a"b"`, `name=a$v`). Inside
`where` and `find`, and inside a group, the rule does not apply (`where
comment="a"b` and `("a"b)` parse). A command argument whose property parser
takes the glued part also passes: `dst-address-list=!"my list"` and
`dst-port=80,"443"`.

### 46. Statement ids and source ownership

```bash
centrs explain ':if (true) do={ :foreach i in={1;2} do={ :put $i } } else={ :put 0 }; :put 3' --json
```

The statements keep discovery order and have ids `s0` through `s4`.
The `foreach` (`s1`) has `parent: "s0"`; its `put` (`s2`) has `parent: "s1"`;
the `else` body's `put` (`s3`) has `parent: "s0"`. The final `put` (`s4`) has
no parent. The published `do` and `else` blocks both have `owner: "s0"`;
`s1` and `s2` share `block: 0`, and `s3` has `block: 1`. A `[find]` inside a
body names that body's statement as its `owner`. Links describe source
ownership; binding and execution-context claims remain separate (#507).

### 47. A stored script stays opaque

```bash
centrs explain '/system/script/add name=proof source={ :local x 1; :put $x }; :put 2' --json
```

Only the installing command (`s0`) and final `put` (`s1`) appear in
`statements[]`; neither has a parent, and `blocks[]` stays empty. The deferred
body's local and `put` are not exposed as statements. Scheduler `on-event=`
and Netwatch `down-script=` have the same structural boundary.

The CHR controls in `test/integration/explain-structure.test.ts` parse the
scope examples and compare stored-script creation, explicit `run`, and an
immediate `:do` body. Those are test operations on disposable CHR; explain
itself never executes the analyzed input.

### 48. Safe argument discovery distinguishes spaced arguments from flags

```bash
centrs explain $R '/interface set ether1 name x' -u $U -p $P --json
centrs explain $R '/interface print detail without-paging' -u $U -p $P --json
```

`data.live.arguments[]` cites command-level child evidence and statement `s0`.
The first result includes `name`, the second includes `detail`. Both parse;
only `name x` gets the device's obsolete-syntax warning. An unknown argument
control (`/interface set ether1 definitely-unknown-491=x`) carries the shared
parse classifier's rejection. No command-level completion is requested.

The integration controls also explain a write-shaped identity change and a
substitution without executing either, verify identity before/after, exercise
CLI stdin and quickchr resolution, and skip oversized highlight without
submitting a prefix. Parse/hash/normalization evidence preserves the Unicode
byte coordinates. Run on long-term as well as stable before changing these
claims. Sanitized captures can be regenerated with `CENTRS_EXPLAIN_CAPTURE`
pointing at an ignored output file when running the integration suite.

### 49. `?`, a backtick and a second `=` need quotes

```bash
centrs explain '/tool/fetch url=http://x/a?b=c' --json
```

`data.verdict` is `fail` with `explain/canonicalizer/unquoted-reserved-byte`
at the `?`. The device answers `expected end of command (line 1 column 27)`,
the same byte. A backtick is rejected the same way, in a value, a
positional, a `where`, a `find`, an array and an expression. A second `=` in
a menu command's argument is rejected at that `=`. So `name=a=b` and a bare
base64 key ending in `=` both fail. The value's property parser never takes
these bytes: `regexp=a?b` and `secret=abc==` are rejected too. In a menu
command's argument name, the device reports from the name's first byte
(`/ip/address/add a?b=1` at the `a`). `url="http://x/a?b=c"`,
`where comment=a=b`, `[find comment=a=b]`, `{a=b}` and `# a?b` pass.
`:put a=b` abstains: 7.24.5 reads it as a named argument and 7.23.8 rejects
the `=`.

### 50. A non-ASCII character outside a string is rejected

```bash
centrs explain ':put $café' --json
```

`data.verdict` is `fail` with `explain/canonicalizer/unquoted-non-ascii` over
the `é`. The device answers `expected end of command (line 1 column 10)`, at
the `é`'s first byte. RouterOS reads only ASCII outside a string. A bare
value (`name=router-café`, `name=🛰`), a reference, a path (`/systemé`), a
verb, an argument name, a `where` value, an array and an expression are all
rejected. So are pasted non-breaking spaces, curly quotes and ellipses. A
declared name (`:local café`) keeps its `invalid-name` error. Strings and
comments carry any byte: `:put "café"`, `:local "café" 1`, `$"café"`,
`name="router-🚀"`, `# café` and a multi-line string pass. The informational
`non-ascii` fact is still published beside the error, and a leading BOM is
not read as part of the first word.

### 51. A brace after a submenu opens a block at any depth

```bash
centrs explain '/ip { address { print {1;2} } }' --json
```

`data.verdict` is `fail` with `explain/canonicalizer/invalid-command-brace` at
the inner `{`. The device answers `expected end of command (line 1 column 23)`,
the same byte. `address {` inside `/ip { … }` is a block over `/ip/address`,
so `data.structure.statements` reads `/ip`, `/ip/address` and
`/ip/address print`, and the `{1;2}` is the operand of `print`.

The device reads a brace after a menu word as statements whatever the body
holds, at any depth. A body offline cannot resolve abstains with
`unresolved-statement` instead of failing as an array:
`/ip { address { 1;2 } }` (the device says `bad command name 1`) and
`/ip { address { zzznotamenu { print } } }` (`syntax error`) both give `warn`,
as `/ip/address { 1;2 }` and `/ip { zzznotamenu { print } }` do.
`/ip { address { print } }` and `/ip { firewall { filter { print } } }` pass.
The menu must be known from the source alone, so a block after a navigation
statement (`/ip⏎address { … }`), an abbreviation (`addr {`) and a digit-led
menu (`6to4 {`) keep the older reading.

### 52. A live call observes a type only where the device converts a literal

```bash
centrs explain $R ':local x 2.2; :set x "2.2"; :local z (1,0x10,2.2); :local t 200ms; :local i *1; :local y yes' -u $U -p $P --json
```

This is example 26's input against a target. The bare `2.2` gains
`facts.observedType: { value: "ip", rendered: "2.0.0.2" }`, `200ms` gains
`time` (`00:00:00.200`) and `yes` gains `bool` (`true`). Of the array's
members, `0x10` is `num` (`16`) and `2.2` is `ip`, while `1` renders unchanged
and gets nothing. The quoted `"2.2"` and the id `*1` also get nothing, because
an unchanged rendering proves no type: `:parse` prints a string unquoted. The
`shapeHints` are untouched, and no record has `schemaType`, because no value
here is a menu command's argument.

A scripting directive's named argument is an operand too:
`:for i from=0x10 to=20 do={:put $i}` gives `from` the fact `num` (`16`), and
`to=20` renders unchanged and gets nothing. A NAME slot is a variable, never a
value: in `:local yes 2` and `:local name=no value=yes`, the names `yes` and
`no` get nothing (the device renders `name=$yes`, `name=$no`), while
`value=yes` is `bool`.

Each fact cites one `:parse` evidence entry per context (operands, members)
with `facet: "types"` and `basis: "derived"`. The probe re-parses each literal
alone, as `:local vN <lit>` or `:local vN {<lit>}`; the analyzed input and
the literals are never evaluated, and no `:typeof` is sent.

### 53. A live call normalizes each argument's declared type

```bash
centrs explain $R '/ip/dns/set servers=1.1.1.1,8.8.8.8; /ip/route/add gateway=2.2 dist=2 comment=abc; /ip/firewall/filter/add chain=input dst-port=80,443 protocol=tcp disabled=yes' -u $U -p $P --json
```

Each `name=value` gains `facts.schemaType` from one argument-level `syntax`
probe. `servers` is `{ values: ["ip", "ip6", "enum"], declared:
"Address[@VRF]" }`, and `gateway` is `ip`, `ip6`, `enum`. `dist` resolves as
the unique prefix of `distance` and is `num`. `comment` is `str`. `chain` is
`enum` plus `str`, since custom chains are legal. `dst-port` is `num` with
`list: true`. `disabled` gets nothing, because the device declares a boolean
with a blank row. No menu argument gets `observedType`: its own parser
converts it, which is the schema's slot. The text output prints
`observed=ip(2.0.0.2)` and `schema=ip|ip6|enum` on the value rows.
