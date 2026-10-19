# `usage/invalid-cursor`

An explain --cursor is not a byte offset inside the input being analyzed.

## Typical trigger

`centrs explain <router> '<input>' --complete --cursor <byte>` with a value that
is not a whole number, or that is larger than the input's UTF-8 byte length.
Library callers get the same code for an original-document position
(`{ line, character }`) that addresses no character in the input.

The check runs before any connection is made, so nothing is sent to the router.

## Fix

- Count the cursor in **UTF-8 bytes**, not characters: `é` is two bytes and
  `🛰` is four. The end of the input (the default) is the input's byte length.
- A cursor inside a multi-byte character is accepted and moves back to that
  character's first byte.
- Omit `--cursor` to complete or describe at the end of the input.
