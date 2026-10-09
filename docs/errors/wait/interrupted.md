# `wait/interrupted`

The wait was cancelled before readiness or its condition was established.

## Fix

Run the wait again when you want to continue. Ctrl-C or an aborted library
signal is a failure to establish the condition, even if some reads completed.
The final envelope reports `meta.operation.wait.stopReason: "interrupted"`
and the partial attempts and observations.
