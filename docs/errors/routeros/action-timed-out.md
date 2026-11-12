# `routeros/action-timed-out`

RouterOS stopped waiting for a command's reply at that command's own limit
and dropped it. After the command was sent, it may still be running, or it
may have finished: centrs cannot tell which.

During a validation check before the command is sent (`execute`'s `:parse`
and `/console/inspect`, and the `/console/inspect` checks of `api` and of
`retrieve` in every mode, `--follow` included), the same trap means the
router did not answer the check. Nothing ran: the summary says the
command was not sent, `context.commandSent` is `false`, and the device
validation stage reads `not reached`. Run the command again once the router
answers.

## Typical RouterOS strings

- `action timed out (13)`: a native-API `!trap`.

Grounded on CHR 7.24.6, 7.25 and 7.25.1 (#639). These are limits of particular RouterOS commands,
not of the native API: structured native-API commands collect replies until
`!done` with no known limit.

| Command | What happens | Measured |
| ------- | ------------ | -------- |
| `/execute` with `as-string` (what `centrs execute` sends for every script over native API) | 7.25 and later: traps when a script that ran longer than about 60 s *finishes*. 7.24.6: traps at a fixed 60 s while the script keeps running. | `:delay 65s` traps at 65 s on 7.25 and 7.25.1, at 60 s on 7.24.6; the script ran to the end on both. `sleep 130` inside `/container/shell` traps at 131 s (7.25). |
| `/container/shell` | Cuts its reply off at about 60 s, at a fixed time. The command keeps running. | On 7.25: `sleep 65` traps at 62 s, `sleep 130` at 61 s; a `sleep 90; date > file` wrote its file about 30 s after the trap. |

REST has its own, separate 60-second cap on every request:
[`routeros/session-closed`](session-closed.md).

## Fix

- After the command was sent: check the router's state before running it
  again. A write that hits this also carries the
  `transport/write-outcome-unknown` warning.
- centrs `--timeout` does not extend the limit; it belongs to the RouterOS
  command. Switching `execute` to REST does not help either: REST caps every
  request at 60 seconds. `execute --via ssh` runs the script at the console,
  not through `/execute as-string`, so this limit does not apply there.
- For long work, start it in the background and poll for its result:
  `:execute {…}` without `as-string` runs the script as a
  `/system/script/job` and returns at once; then wait on what it changes with
  `centrs retrieve … --wait --until …`.
- Where the command has its own timeout, bound it below the limit:
  `/container/shell timeout=<seconds>` takes bare seconds (`timeout=200s` is
  rejected) and kills the command cleanly at that time. It only lowers the
  limit; a value above 60 still traps at about 60 s.
