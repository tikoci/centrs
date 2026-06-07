# stream

Follow live RouterOS output — `print follow`, `monitor`-style commands, and
sniffer feeds — as a stream of envelopes.

Status: `designed`. This file describes intent and flags; no implementation yet.
See `docs/MATRIX.md` for the cell states. `stream` lands with a transport that
can hold an open read (native-api first, then ssh); it is **not** a REST cell.

## Why a separate verb

`stream` exists because open-ended follow is a different I/O contract than a
one-shot read, and conflating it into `retrieve` would force every retrieve
consumer to handle "maybe this is a stream." A caller that picks `stream` knows
it is getting a sequence of frames, not a single envelope. Bounded, finite
captures stay on `retrieve` (`--once`); interactive PTY stays on `terminal`
(constitution: protocol selection).

## Intent

- **Read-only**, validated like `retrieve` (path-shaped commands gate through
  `/console/inspect`). `stream` never writes.
- Wraps RouterOS follow semantics: `once`, `follow`, `duration=`,
  `freeze-frame-interval=`. Targets are the `monitor`/`print follow`/sniffer
  family of menus.
- **Transport:** true follow cannot ride REST (RouterOS REST has a 60s hard
  cap), so `stream` is **native-api / ssh-first**. `--via rest-api` is
  bounded-or-rejected, never a silent open-ended poll.
- Not a fan-out surface in single-session mode: a single `stream` rejects N>1
  targets with `usage/fanout-not-supported` (constitution: target selection).

## Output contract (NDJSON stream of envelopes)

- Each frame is **one envelope** (`{ ok, data?, warnings?, error?, meta }`),
  emitted as one NDJSON line under `--format json`. Text mode renders
  human-readable frames.
- The stream is terminated by a final **summary envelope**: frame count,
  duration, and stop reason (`duration-elapsed`, `interrupted`, `eof`,
  `transport-error`).
- A mid-stream RouterOS or transport error is itself a frame with `ok: false`;
  the **process exit code** reflects whether the stream *started* cleanly, not
  whether every frame was `ok`.
- `--duration` / `--count` bound an otherwise open-ended follow; Ctrl-C stops it
  and still emits the summary envelope.

## Flags (planned)

| Flag | Behavior |
| ---- | -------- |
| `--via <protocol>` | Pin transport (`native-api` or `ssh`). REST is bounded-or-rejected. |
| `--duration <dur>` | Stop after this wall-clock window (maps to RouterOS `duration=`). |
| `--count <n>` | Stop after N frames. |
| `--freeze-frame-interval <dur>` | RouterOS `freeze-frame-interval=` passthrough. |
| `--format <text\|json>` | `json` is NDJSON (one envelope per line); `text` is human frames. |

`tail` is a log-scoped alias: `centrs tail <router> /log` ≈ `tail -f` over
`/log print follow`.

## Open questions

- Whether `stream` over ssh shells out to the RouterOS CLI follow or rides a
  structured channel; settle during the SSH transport work.
- Backpressure / max-buffered-frames policy for a fast producer.

Sequencing (decided): do **not** start `stream` until (1) a native-api
*streaming* spike confirms the reader is solid as a long-lived follow channel
(not just request/response), and (2) `retrieve` is further along and re-reviewed
for UX — `stream` should inherit a settled retrieve shape, not race it. The
native-api streaming reader already exists (`src/protocols/native-api.ts`) and is
the first follow consumer.
