# `input/max-results-exceeded`

The result was larger than the `--max-results` byte budget, so centrs
returned this error instead of the output. For `retrieve` nothing changed.
For `execute`, the command already ran on the router; only its output is
withheld.

## Emitted by

`retrieve`, `execute` and `execute --cmr` *(code)*.

## Context

- `requiredBytes`: the size of the full result.
- `maxResultsBytes`: the budget.
- `command`, `path`, `objectCount`: what produced it.

## Fix

- Raise the budget to at least `requiredBytes` with
  `--max-results <bytes>`. Dropping the flag is not enough when the budget
  also comes from `CENTRS_MAX_RESULTS` or `centrs.env`:
  `centrs settings print` shows where it is set, and
  `centrs settings reset max-results` removes the saved one.
- Ask for less: `--attributes` or a filter on `retrieve`, or a narrower
  `print` on `execute`.
- After an `execute` write, do not rerun it to see the output. Check the
  router's state with a read instead.

## Related

- [`usage/timeout-out-of-range`](../usage/timeout-out-of-range.md)
