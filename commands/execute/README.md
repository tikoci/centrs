# execute

Run a RouterOS CLI command and return its (semi-structured) output.

Status: `not-started`. This file is a stub. Promote to a full design when
`retrieve` is `CHR-passed`.

## Intent

- Mirror RouterOS `execute` semantics. Input is a CLI string; output is
  console-shaped text wrapped in the standard envelope.
- Validation runs through `:put [:parse "<cmd>"]` (via `/rest/parse`), not
  `/console/inspect`. Parse is the right tool for CLI-shaped commands.
- REST adapter calls `/rest/parse` then `/rest/execute`.
- Output is *string*-shaped; richer parsing is a future concern. The envelope
  must still distinguish RouterOS errors from successful runs (a 200 with a
  RouterOS error string is still an error — see constitution: error model).

## Open shape questions

- How to expose multi-line / async / progress output without committing to a
  single-shot model up front.
- Whether `--strict` should reject "succeeded with stderr-like content."

Defer until `retrieve` has settled the envelope.
