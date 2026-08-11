# `scripts/probes/` — device re-derivation recipes

These scripts ask a real CHR a question, score a committed device capture, or
replay recorded probe output whose **answer is already committed elsewhere**.
They exist so a version bump is a re-run rather than an archaeology exercise
(#186).

They are not tests, are not wired into any gate, and assert nothing. A live
probe needs `@tikoci/quickchr` (an optional dependency) or a reachable CHR,
prints a table, and writes its capture to `.scratch/`; a scorer or replay tool reads
such a capture and prints the comparison. Captures are in-flight by design,
because only a reviewed slice that lands under `test/fixtures/` is durable.

| Probe | Re-derives | Durable answer |
| ----- | ---------- | -------------- |
| `explain-brace-slot-sweep.ts` | which `(verb, slot)` pairs read `{…}` as an array (#225/#257) | `src/explain/brace-slots.ts` + `test/fixtures/explain/values.json` → `interiorGrounding.braceSlots` |
| `explain-escape-sweep.ts` | the device-accepted `\<c>` set inside a string (#252) | `VALID_SINGLE` in `src/explain/quoted-string.ts` |
| `explain-highlight-recapture.ts` | the per-character `highlight` stream for every corpus script (Q13) | `test/fixtures/explain/highlight-streams.slice.json` (a stratified slice; the full capture is ~7.5 MB/version and stays out of the repo) |
| `explain-symbol-anchors.ts` | the constructed F1/F2/H5/H6 symbol corners on live `highlight` | `src/explain/symbols.ts` + `test/unit/explain-symbols.test.ts` |
| `explain-symbol-arms-score.ts` | the Q13 candidate-arm score over a full highlight capture | the F1/F2 decisions in `src/explain/symbols.ts` |
| `explain-symbol-bad-sigil-replay.ts` | recorded K2 hard-error offsets | the F8 anchors in `test/unit/explain-symbols.test.ts` |
| `explain-symbol-classes-replay.ts` | recorded K3 per-occurrence variable classes | the F7 anchors in `test/unit/explain-symbols.test.ts` |

## Rules a probe here must follow

- **Both oracles must see the same bytes.** RouterOS substitutes inside double
  quotes, so a `$` in a `:parse "<input>"` wrapper reaches the device already
  replaced and the row's answer is about a different program (#269). Escape it
  or refuse the input; do not let a probe ask a question it cannot name.
- **`highlight` and `:parse` are different oracles and disagree.** `highlight`
  accepts `{1;2,}`, `{2,}` and `{(1,2),}`, all of which `:parse` rejects. Say
  which one a row was scored on.
- **Import `@tikoci/quickchr` through `./chr.ts`.** It ships TypeScript source
  rather than declarations, so a static import pulls its whole tree into
  `tsc --noEmit` and fails on 82 errors that are not ours. `chr.ts` uses the
  same variable-specifier trick as `test/integration/chr.ts`.
- **Resolve the corpus through `../corpus-fetch.ts`.** A hardcoded
  `$HOME/GitHub/lsp-routeros-ts` path is the reachability bug #186 exists to
  fix, and the resolver announces which snapshot's bytes were measured.
- **A replay must reject an empty input set.** Printing `0/0 agree` is not a
  successful replay and must not look like one.
