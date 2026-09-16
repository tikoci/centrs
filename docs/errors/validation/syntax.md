# `validation/syntax`

The command syntax was rejected by the validation gate — offline analysis, or
the RouterOS `:parse` probe.

The gate has two stages
([`docs/CONSTITUTION.md` → Validation is the product](../../CONSTITUTION.md#validation-is-the-product)),
and `error.context.validationStage` says which one spoke:

- **`"offline"`** — centrs rejected the input before any connection was opened,
  and `meta.validation.stages[]` shows the device stage `skipped`: the router was
  never asked. The **corpus-gated analyzer** is the whole of this stage, and
  `error.context.validationSource` names it. `error.context.span` carries the
  offending byte range (end-exclusive) and `error.context.diagnostics[]` the
  analyzer's own `explain/<analyzer>/<slug>` codes.

  A quote-balance supplement used to sit beside it for the unterminated `"` or
  `'` the analyzer passed, reporting no span. It is gone (GH#355): the analyzer
  rejects a bare `'` itself now, with the byte span, and the supplement's own
  model of `'` as a delimiter was false-rejecting input RouterOS accepts.
- **absent** — RouterOS itself rejected it, through `:put [:parse "…"]`. When the
  device reported a `(line N column M)`, it is on `error.position`, which is
  RouterOS's authoritative 1-based **byte** column and is never synthesized by
  centrs. An offline rejection never carries `error.position`.

## Fix

Run `centrs explain '<command>'` to see the offending bytes in context, fix the
RouterOS CLI syntax — quotes and bracketed expressions most often — and retry.

`--validate=false` bypasses **both** stages. Use it only to probe a RouterOS edge
centrs reads wrong, never to work around a rejection you believe is correct: if
the validator rejects something a real router accepts, the validator is the bug
(constitution: validation is the product).
