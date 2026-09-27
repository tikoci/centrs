# `transport/cancel-unacknowledged`

RouterOS did not acknowledge a stream's /cancel within the timeout; centrs ended
the stream and closed the session locally.

## When it happens

This is a **warning** on the summary envelope of `centrs api … --stream`, not a
failure. The stream stopped for its normal reason (`--duration` elapsed, or
Ctrl-C), and centrs sent RouterOS `/cancel` for the `/listen`. A cooperating
router answers with an `interrupted` trap and `!done` within milliseconds. This
one did not answer within `--timeout`, so centrs stopped waiting, closed the
native API session and finished.

The summary's `stopReason` is still the reason the stream stopped. The warning
records that the router never confirmed the cancel, so the stop was local.

## Fix

- Usually nothing: the stream ended when you asked, and the session is closed.
- If it repeats against one router, the API connection is likely stalled (a
  router under load, or a firewall or NAT device holding the TCP session).
  Check the router's CPU and the path to it before relying on long-lived
  streams there.
