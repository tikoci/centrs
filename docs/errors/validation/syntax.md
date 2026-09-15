# `validation/syntax`

The command syntax was rejected by the validation gate — offline analysis, or
the RouterOS `:parse` probe.

The gate has two stages
([`docs/CONSTITUTION.md` → Validation is the product](../../CONSTITUTION.md#validation-is-the-product)),
and `error.context.validationStage` says which one spoke:

- **`"offline"`** — centrs's own corpus-gated analyzer rejected the input before
  any connection was opened. `error.context.span` carries the offending byte
  range (end-exclusive) and `error.context.diagnostics[]` the analyzer's own
  `explain/<analyzer>/<slug>` codes. `meta.validation.stages[]` then shows the
  device stage `skipped`: the router was never asked.
- **absent** — RouterOS itself rejected it, through `:put [:parse "…"]`. When the
  device reported a `(line N column M)`, it is on `error.position`, which is
  RouterOS's authoritative 1-based **byte** column and is never synthesized by
  centrs.

## Fix

Run `centrs explain '<command>'` to see the offending bytes in context, fix the
RouterOS CLI syntax — quotes and bracketed expressions most often — and retry.

`--validate=false` bypasses **both** stages. Use it only to probe a RouterOS edge
centrs reads wrong, never to work around a rejection you believe is correct: if
the validator rejects something a real router accepts, the validator is the bug
(constitution: validation is the product).
