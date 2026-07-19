# explain — examples

Each numbered example is an executable spec. Once `explain` is implemented,
offline examples run under `test/unit/explain.test.ts` and live examples under
`test/integration/explain.test.ts` against a CHR booted by `@tikoci/quickchr`
— one assertion per example (example N ↔ assertion N). Until then these are
the **target**: the cells are `designed`, nothing here is green yet, and the
flag names track the strawman in `README.md` (Option A) — if the design round
changes the surface, this file changes with it.

`$R` is `<host>:<rest-port>` resolved by quickchr; `$U` / `$P` are CHR
credentials from the harness. Envelope-asserting examples pass `--json`.

## Offline (no router, no CDB)

### 1. Canonical form and write shape

```bash
centrs explain "/ip/route add dst-address=10.9.0.0/16 gateway=192.0.2.1" --json
```

`ok: true`; `data.canonical` is
`{ path: "/ip/route", verb: "add", mode: "structured", writeShaped: true }`
with the args split out; no diagnostics of severity `error`; exit `0`.

### 2. Script mode is reported, not widened

```bash
centrs explain ":foreach i in=[/ip/address find] do={ :put $i }" --json
```

`data.canonical.mode` is `"script"` and `writeShaped` reflects the gate's
conservative verdict — the same answer `execute` would act on.

<!-- cspell:ignore frewall -->

### 3. Unknown path is a snapshot fact (deliberate `frewall` typo)

```bash
centrs explain "/ip/frewall/filter add chain=forward" --json
```

A diagnostic (`explain/schema/unknown-path` or similar) whose `source` is
`static-schema` and whose message names the **snapshot version**, not the
device; exit `2` at the default `--fail-on error`.

### 4. Describe a path (schema facet)

```bash
centrs explain /ip/firewall/filter --schema --json
```

`data.schema` lists child commands (`add`, `set`, `print`, …) and argument
names with types (`chain`, `action`, …), each fact labeled `static-schema`.

## Live (CHR target)

### 5. Highlight spans and the error byte

```bash
centrs explain "/ip/address add address=bogus interface=" $R -u $U -p $P --json
```

`data.spans` classify the input byte-by-byte (path/command/argument classes);
the first hard error's byte offset appears in a diagnostic with `source:
"live-inspect"`; `data.target.version` matches the CHR.

### 6. Structure via :parse

```bash
centrs explain ":if (1 > 2) do={ :put x " $R -u $U -p $P --json
```

The unclosed block yields a `:parse`-derived diagnostic carrying line/column;
no partial structure is fabricated past the first hard error.

### 7. Completion candidates at the cursor

```bash
centrs explain "/ip/firewall/filter add ch" $R -u $U -p $P --complete --json
```

`data.completion` includes `chain` with `source: "live-inspect"`; candidates
are labeled as observed, never as a closed set.

### 8. Runtime acceptance is never claimed

```bash
centrs explain "/ip/route add dst-address=10.9.0.0/16 blackhole=yes" $R -u $U -p $P --json
```

Even when every probe passes, `data.runtimeAcceptance` is `"not-proven"` —
the inspect-vs-runtime gap stays machine-readable.

### 9. Fan-out is rejected

```bash
centrs explain "/ip/route print" --group lab --json
```

`ok: false` with `usage/fanout-not-supported`; `explain` takes at most one
router.
