# `transport/timeout`

centrs stopped waiting for the device. The connection, the login, or the
command did not finish within the timeout. Whether a command ran depends on
where the wait stopped; the summary says which.

## Typical triggers

- The host is unreachable or drops packets silently (a firewall `drop`, no
  route), so connecting never completes.
- A login that never completes, for example a mismatched service or a router
  under heavy load.
- A command that runs longer than `--timeout`. Over SSH the summary says the
  command may still be running, keeps the output printed before the cutoff in
  `context.partialOutput`, and `context.sessionReached` says whether the
  login was seen.
- Commands that drop the connection on purpose (`/system/reboot`,
  `/system/package/update/install`, `/system/device-mode/update`) report this
  today; see the
  [Provisioning theme](../../MATRIX.md#provisioning), which absorbed #363.

## Fix

- Raise `--timeout` (or `CENTRS_TIMEOUT`, or the CDB `timeout=` key). REST is
  capped at 60 s by RouterOS and centrs refuses more.
- Some RouterOS commands drop their reply at about 60 s whatever the timeout:
  see [`routeros/action-timed-out`](../routeros/action-timed-out.md).
- If a write timed out after it was sent, check the router's state before you
  re-run it: the outcome is unknown, not failed.
- Confirm the host and port answer: `ping`, `/ip service print`.
