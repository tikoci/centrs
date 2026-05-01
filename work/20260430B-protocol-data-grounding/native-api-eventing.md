# Native API eventing notes

Native API is not the preferred first read-only alpha transport, but it is the
only currently grounded RouterOS eventing path. Proxy, SSE, HTTP streaming, and
future live diagnostics should be designed with this in mind.

## Grounded facts

- RouterOS API replies are sentence-based and can be tagged.
- A command can include `.tag=<value>`; returned sentences for that command echo
  the tag.
- Streaming commands such as `/listen` and monitor commands can emit multiple
  `!re` sentences before `!done`.
- `/cancel =tag=<value>` is the normal way to stop an in-flight tagged command.
- `/cancel` is itself a separate command with its own optional `.tag`; the
  `=tag=` argument names the command to interrupt.
- Cancelled commands normally return `!trap` with category `2` and message
  `interrupted`, then `!done`.
- API connections can also return `!fatal` before closing, so stream consumers
  need a distinct connection-fatal error path.
- RouterOS API docs warn that attribute word order should not be relied on.
- RouterOS API docs warn that query word order is significant.
- RouterOS API docs warn that regular-expression queries are not supported.
- `tiktui` and `restraml` both have pure TypeScript/Bun API clients with
  `write`, `writeFull`, and `listen`-style surfaces.
- `tiktui` demonstrates the useful split: REST for one-shot reads and native API
  for `/listen`/monitor streaming, with SSE as a presentation layer.
- Cross-project evidence from `restraml` says multiplexed native API batches can
  crash the RouterOS API process in some bulk `/console/inspect` workloads.
- `tiktui` tests cover `monitor-traffic =once`, `/interface/listen`,
  multi-packet streams, stream cancellation, and stream plus parallel write
  coexistence against the native API client shape.
- `restraml` evidence narrows the hardest failure mode to bulk
  `/console/inspect` enrichment, where concurrent work can time out and leave
  ghost in-flight commands that stall the queue; it does not yet prove whether
  ordinary tagged reads or long-lived listens share the same risk.

## Design implications for centrs

- Treat native API streaming as strategically important, not as an alpha blocker.
- Do not expose SSE/HTTP streaming as "REST eventing"; make the underlying
  native API requirement explicit.
- Treat SSE and WebSocket streams as presentation/proxy surfaces over an adapter
  stream, not as RouterOS data sources.
- Prefer one API connection per long-lived stream until multiplexing safety is
  proven for the command class.
- Keep cancellation, orphan replies, traps, and connection teardown as first-class
  test cases.
- Before native API is used for validation or eventing in core code, capture a
  CHR-backed lab that tests tags, `/listen`, `/cancel`, trap handling, and
  connection recovery.

## Follow-up research

- Is the restraml multiplexing crash specific to `/console/inspect`, to one API
  method, to request volume, or to general shared-connection multiplexing?
- Which commands are safe to stream concurrently on one connection?
- What typed error should `centrs` return for `!trap`, `!fatal`, interrupted
  streams, and orphan replies?

## Candidate CHR test shape

- Start with one native API connection and run a tagged read command that returns
  multiple `!re` replies followed by `!done`.
- Run `/interface/listen` with a unique `.tag`, mutate a harmless interface
  property on a separate command, then cancel the listen with `/cancel =tag=...`.
- Assert the stream reports the update, handles `!trap category=2` as an
  intentional cancellation, and drains the final `!done`.
- Repeat with one long-lived stream per connection before testing any shared
  connection multiplexing.
