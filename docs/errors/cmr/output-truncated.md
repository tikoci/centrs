# `cmr/output-truncated`

A warning: CMR clipped a client's command output at its cap (about 60 KiB on
7.26beta1) and appended `...(+N B)`. The command **completed**; only the
returned text is incomplete. The envelope's `meta.truncated` records it.

## Typical trigger

A command that prints a lot, such as a large `print` or `/export`, run with
`execute --cmr`.

## Fix

Narrow the output on the client: `print` with `where` and `proplist=`, or
`:put` only the fields you need. For a full configuration, save it to a file on
the client instead of printing it.
