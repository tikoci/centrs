# `input/invalid-target`

The target string is invalid for the requested operation.

A command's `<router>` is looked up in the CDB first: its `target`, or an
`identity=` / `mac=` / `ip=` comment lookup key. When nothing matches, centrs
treats the string as a host. This error means it is not a valid host either,
or it is a URL that carries a path. Common causes:

- **`quickchr:NAME`**: there is no `quickchr:` target prefix. A quickchr VM is
  selected with a flag: `--quickchr NAME`.
- **A typo or stray characters**, such as spaces or an extra `:` (`a b`,
  `bad:host:name`).
- **A base URL with a path**, such as `http://192.0.2.1/rest`. The RouterOS
  menu path is a separate argument.

The rejected string is in the error's `context.target`.

## Fix

Pass one of the accepted target forms:

| Form | Example |
| ---- | ------- |
| CDB target or lookup key | `edge1` (see `centrs devices list`) |
| IP address or hostname, optional `:port` | `192.0.2.1`, `router.example:8080` |
| Base URL without a path | `https://192.0.2.1:8443` |
| quickchr VM | `--quickchr NAME` (a flag, not a prefix) |

With an explicit `--cdb-file` and no `__default__` fallback record, a string
that matches no record stops earlier with `cdb/not-found-target`.
