# `quickchr/machine-not-found`

No quickchr machine is registered under the name passed to `--quickchr <name>`.

## Typical trigger

The name does not match any machine quickchr knows about — a typo, a machine
that was never created, or one that has been removed. centrs raises this both
when `QuickCHR.get(name)` returns nothing and when the descriptor call reports
quickchr's own `MACHINE_NOT_FOUND`.

## Fix

- List the registered machines with `quickchr list` and pass an existing name.
- Create/start the machine first if it does not exist yet (`quickchr start
  <name>`).
- Names are exact — check for typos and case.

If the machine exists but is not running, you will see
[`quickchr/machine-stopped`](./machine-stopped.md) instead.

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) → Resolution providers.
