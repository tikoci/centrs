# `explain` fixtures

Every file here is device- or corpus-derived evidence. None of it is
hand-asserted; each carries its own provenance, either in a `_source` key or in
the notes below.

Most files are the promoted phase-0.5 lab corners consumed directly by
`test/unit/explain-*.test.ts` (`segments`, `blocks`, `verbsplit`, `symbols`,
`pathresolve`, `write`, `defects`, `coordinates`, `values`). The three below are
different: they are **method artifacts**, promoted out of `.scratch/` by #186
because durable files were citing them and a `.scratch/` wipe would have taken
the citation's referent with it.

## `corpus-partition.json` — the frozen dev/holdout split

The leakage guard for every corpus-scale `explain` score. Built once
(centrs#185 phase 0) over the 913-script corpus snapshot, grouped by forum
topic so no two posts from one thread land on opposite sides, content-hash
de-duplicated first, then stratified rarest-feature-first to a 0.3 holdout:
336 groups → 237 dev / 99 holdout, 639 dev / 272 holdout scripts.

**This file is the reason the numbers in `src/explain/symbols.ts` mean
anything.** A score taken on a different split is not comparable to a score
taken on this one, so re-deriving the split rather than reading it silently
invalidates every figure that cites it. It is frozen: it is not regenerated
when the corpus grows.

Two live consequences of it being older than the pinned corpus:

- the corpus now has **948** scripts; this split was built over a 913-script
  snapshot and names **911** of them (2 are content-hash duplicates, dropped
  and listed under `duplicates`). All 911 paths still resolve in the pinned
  snapshot, so the join is exact — but the 35 newer scripts are in neither arm
  and must be **excluded** from a split-scored measurement, not folded into
  one.
- `edge-cases/*` paths are pinned to dev by construction (rule R3), because
  they are hand-built corners rather than found scripts.

## `highlight-streams.slice.json` — the per-token device oracle

See the file's own `_source` block. It is a stratified slice of the two
full-corpus `highlight` captures; the full captures are ~7.5 MB per RouterOS
version and are not committed. Re-cut with
`bun run explain:highlight-slice`, recapture with
`bun run explain:probe:highlight-recapture`.

**Generated output — never hand-edit it.** Patching a single pair by hand
breaks the chain the file claims for itself: its `source.captures` sha256 would
no longer identify the bytes it was cut from, and `test/unit/explain-highlight-
slice.test.ts` checks the header against the data, not the data against the
device. Change the rule in the generator and re-cut.

## `transport-rest-q8.v7.23.2.json` / `.v7.24rc2.json` — the Q8 REST probe

The captured evidence behind `src/explain/transport.ts`. Each row is one
CLI-shaped operation actually issued against a CHR, with the method, URL, body,
HTTP status and a note on the response shape. `ok` is whether the rule the row
demonstrates held.

Read them as what they are: **five rules exercised**, four CRUD verbs as
themselves plus one menu action. `transport.ts` widens the fifth into a family
by an explicit maintainer decision (#241 review), not because the probe covered
the family. Nothing else here is a licence to widen.
