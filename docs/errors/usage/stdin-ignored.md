# `usage/stdin-ignored`

stdin was redirected but the input came from the positional argument, so
anything piped in was not analyzed.

This is a **warning**, not an error: the analysis ran and its result is exactly
what the arguments asked for. What the warning reports is that a second possible
input source was present and lost.

## Fix

Name the source you meant:

```bash
cat script.rsc | centrs explain --file -       # analyze stdin
cat script.rsc | centrs explain edge1 --file - # ...in the live form
centrs explain '/ip/route print'               # analyze the positional
```

`explain` reads ambient stdin only when no positional could be the input, so a
positional always wins. It cannot check whether the pipe actually carries bytes
without consuming fd 0, which is why the collision is reported rather than
resolved. See [`commands/explain/README.md`](https://github.com/tikoci/centrs/blob/main/commands/explain/README.md)
for the positional grammar.
