# `routeros/session-closed`

RouterOS closed the session before the request completed.

## Typical RouterOS strings

- `Session closed`: over REST, RouterOS ends a request after 60 seconds
  ([Keep commands within 60 seconds](https://manual.mikrotik.com/docs/developer-guides/rest-api#keep-commands-within-60-seconds)).
  It can come sooner while the router is still busy with earlier requests: on
  CHR 7.25, four parallel calls started while earlier ones still ran all got
  it at 44 s (#638).
- SFTP: an SSH disconnect with reason 7 (service not available), when the
  user's group lacks the `ftp` policy.

The REST cap applies to every request. It is separate from the reply limits
some commands carry on any transport, which surface over native API as
[`routeros/action-timed-out`](action-timed-out.md).

## Fix

- A command that was already sent may still be running or may have finished.
  Check the router's state before running it again; a write that hits this
  also carries the `transport/write-outcome-unknown` warning. During the
  `execute` `:parse` preflight nothing was run yet: the device stage reads
  `not reached`.
- `--timeout` cannot extend the cap. Keep each REST call under 60 seconds:
  start long work in the background (`:execute {…}` without `as-string` runs
  it as a `/system/script/job`) and poll for its result with
  `centrs retrieve … --wait --until …`.
- For SFTP, grant the `ftp` policy to the user's group (`/user/group`).
