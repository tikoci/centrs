# explain — examples

Each numbered example is an executable spec. Once `explain` is implemented,
offline examples run under `test/unit/explain.test.ts` and live examples under
`test/integration/explain.test.ts` (rest-api) and
`test/integration/native-api-explain.test.ts` (native-api) against a CHR booted by
`@tikoci/quickchr` — one assertion per example (example N ↔ assertion N).
Until then these are the **target**: the cells are `designed`, nothing here is
green yet, and flag and field names track the ratified surface in `README.md`.

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
centrs explain '/ip/route add dst-address=10.9.0.0/16 gateway=192.0.2.1' --json
```

`ok: true`; `data.canonical` is
`{ path: "/ip/route", verb: "add", mode: "structured", writeShaped: true }`
with the args split out; `data.structure.statements[0].resolution` is
`"resolved"` and its `transport.classification` is `"api-candidate"` (the
statement is covered by a tested REST mapping rule); `data.verdict` is `pass`;
exit `0`.

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
centrs explain '/ip/address comment numbers=0 comment=uplink' --json
```

`data.canonical.verb` is `"comment"` — at this position `comment` is the
RouterOS *verb* — while `data.canonical.args` carries the `comment` *argument*
with its value. The two roles of the same word are distinguished by position,
and both facts cite canonicalizer evidence (offline heuristics; live
completion is the authority — see examples 13–15).

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

### 18. A bare path is ambiguous offline

```bash
centrs explain '/ip/route' --json
```

The first statement has `resolution: "ambiguous"`: without a schema, the same
shape can be a menu (`/ip/route`) or a no-argument command
(`/system/reboot`). It carries no invented `command`, its transport
classification is `"unknown"`, and a canonicalizer diagnostic explains the
menu-vs-command ambiguity. `data.verdict` remains the independent diagnostic
severity summary; it is not the statement-resolution field.

### 19. Live evidence resolves the same bare path as a menu

```bash
centrs explain $R '/ip/route' -u $U -p $P --json
```

`/console/inspect` completion and highlight agree that the terminal token is a
`dir`; the first statement is `resolution: "resolved"`, `kind: "menu"`, and
has no runnable transport rendering. The evidence entry is version-stamped and
the probe never executes the path.

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

The injected `;` has RouterOS statement-separator semantics. A diagnostic
carries its defect byte region; the tail statement beginning `0` resolves
`"unknown"`, with no confident `/r0` command or runnable transport rendered.
The analysis itself is `ok: true`; `data.verdict` and `--fail-on` report the
diagnostic.

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
