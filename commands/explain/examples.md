# explain — examples

Each numbered example is an executable spec. Once `explain` is implemented,
offline examples run under `test/unit/explain.test.ts` and live examples under
`test/integration/explain.test.ts` against a CHR booted by `@tikoci/quickchr`
— one assertion per example (example N ↔ assertion N). Until then these are
the **target**: the cells are `designed`, nothing here is green yet, and flag
and field names track the decided-but-unratified surface in `README.md` — the
phase-0 grounding lab may still reshape them, and this file changes with the
spec.

`$R` is `<host>:<rest-port>` resolved by quickchr; `$U` / `$P` are CHR
credentials from the harness. Envelope-asserting examples pass `--json`.

## Offline (no router, no CDB — canonicalizer only)

### 1. Canonical form, write shape, and transport

```bash
centrs explain "/ip/route add dst-address=10.9.0.0/16 gateway=192.0.2.1" --json
```

`ok: true`; `data.canonical` is
`{ path: "/ip/route", verb: "add", mode: "structured", writeShaped: true }`
with the args split out; `data.transport.runner` is `"api"` (the statement is
representable as a structured REST operation); no diagnostics of severity
`error`; exit `0`.

### 2. Script mode is reported, not widened — and routes to execute

```bash
centrs explain ":foreach i in=[/ip/address find] do={ :put $i }" --json
```

`data.canonical.mode` is `"script"` and `writeShaped` reflects the gate's
conservative verdict — the same answer `execute` would act on.
`data.transport.runner` is `"execute"` with the `centrs execute` invocation
rendered, so the right runner surfaces even for script input.

### 3. Sub-command paths are re-constituted

```bash
centrs explain "/ip/address remove [find comment=defconf]" --json
```

`data.structure.subcommands` exposes the inner command with its resolved
enclosing path: `{ path: "/ip/address", verb: "find" }` plus its span — the
`[…]` is structure, not an opaque blob. `writeShaped` is `true`.

### 4. Offline is honest about what it cannot know

```bash
centrs explain "/ip/address print" --schema --json
```

No router was named, so no enumeration is fabricated: `data.schema` is absent
(or empty with `truncated: false`), every emitted fact carries `source:
"canonicalizer"`, and a tip states that richer schema/completion data is
available when a router is provided.

### 5. curl rendering with a placeholder host

```bash
centrs explain "/ip/address print" --curl --json
```

`data.transport.rest` carries the method + `/rest/ip/address` mapping and
`data.transport.curl` renders a ready-to-edit `curl` command using a
placeholder host (no router was given) and elided credentials; the equivalent
`centrs api` invocation is rendered alongside.

## Live (CHR target)

### 6. Describe a path: verbs first

```bash
centrs explain /ip/address $R -u $U -p $P --schema --json
```

`data.schema.verbs` lists the verbs available at `/ip/address` (`add`, `set`,
`remove`, `print`, …), each with an arg count or a drill-down hint rather than
the full arg expansion; facts carry `source: "live-inspect"` and
`data.target.version` matches the CHR.

### 7. Describe a verb: its arguments

```bash
centrs explain /ip/address/set $R -u $U -p $P --schema --json
```

`data.schema` enumerates the settable arguments of `set` (`address`,
`interface`, `disabled`, …) with types where the device reports them.

### 8. Describe print: the proplist special case

```bash
centrs explain /ip/address/print $R -u $U -p $P --schema --json
```

`data.schema` returns the `.proplist` value set — what the output *can*
contain — rather than treating `print` like a plain verb.

### 9. Smart sizing truncates with counts, `--full` lifts it

```bash
centrs explain /ip $R -u $U -p $P --schema --json
```

The `/ip` subtree is large: `data.schema.truncated` is `true`, counts are
reported in place of the full expansion, and a warning/hint names the
narrower query (or `--full`) that expands it.

### 10. Spans and the error byte (centrs vocabulary)

```bash
centrs explain "/ip/address add address=bogus interface=" $R -u $U -p $P --json
```

`data.spans` classify the input byte-by-byte using the **centrs** span
vocabulary (not raw RouterOS highlight classes); the first hard error's byte
offset appears in a diagnostic with `source: "live-inspect"`.

### 11. Structure via :parse

```bash
centrs explain ":if (1 > 2) do={ :put x " $R -u $U -p $P --json
```

The unclosed block yields a `:parse`-derived diagnostic carrying line/column;
no partial structure is fabricated past the first hard error.

### 12. Completion candidates at the cursor

```bash
centrs explain "/ip/firewall/filter add ch" $R -u $U -p $P --complete --json
```

`data.completion` includes `chain` with `source: "live-inspect"`; candidates
are labeled as observed, never as a closed set.

### 13. Runtime acceptance is never claimed

```bash
centrs explain "/ip/route add dst-address=10.9.0.0/16 blackhole=yes" $R -u $U -p $P --json
```

Even when every probe passes, `data.runtimeAcceptance` is `"not-proven"` —
the inspect-vs-runtime gap stays machine-readable.

### 14. Fan-out is rejected

```bash
centrs explain "/ip/route print" --group lab --json
```

`ok: false` with `usage/fanout-not-supported`; `explain` takes at most one
router.
