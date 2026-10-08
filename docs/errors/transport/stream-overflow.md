# `transport/stream-overflow`

More stream replies were waiting unread than the buffer allows, so centrs ended
the stream rather than drop any.

## When it happens

`centrs retrieve <router> <menu> --follow` buffers changes between RouterOS and
the reader, up to 50,000. The buffer fills when the reader stops reading (a
stalled pipe), or when a burst arrives while a long snapshot is still loading.
centrs never drops a change silently, because the state you hold would then
look current while being wrong. It ends the follow with this error instead, as
the failed summary (`stopReason: "transport-error"`).

## Fix

- The state you built from the lines is stale. Follow again: the new follow
  starts with a fresh snapshot.
- Read lines as they arrive. Don't buffer the whole output before processing.
- For a very busy menu, follow a narrower menu (for example `/interface/vlan`
  instead of `/interface`).
