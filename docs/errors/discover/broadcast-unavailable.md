# `discover/broadcast-unavailable`

A warning: `discover` could not enable UDP broadcast, so it sent no refresh
requests. It still listened, so the result has only the routers that
announced themselves during the window.

## Context

- `cause`: the error code from the socket.

## Typical triggers

- An agent sandbox or container that refuses broadcast sockets *(code)*.
- A host firewall that blocks outgoing broadcast *(unverified)*.

## Fix

- Listen longer, `--timeout 60s`, to catch more unprompted announcements.
- Run `discover` from a normal shell on the router's layer-2 segment.

## Related

- [`mndp/listen-failed`](../mndp/listen-failed.md): the socket could not be
  opened at all.
