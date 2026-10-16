# `usage/flag-after-separator`

A centrs flag was written after `--`, where every token is RouterOS input.

## Fix

Move the flag before `--`. The error's remediation prints the corrected
command line:

```sh
centrs execute r1 -- '/system/identity/print' --json   # refused
centrs execute r1 --json -- '/system/identity/print'   # fixed
```

A bare `--` ends centrs option parsing, so without this check a trailing
`--json` was sent to RouterOS and failed there as `unknown-attribute`. The check
covers `execute` (including `--cmr`) and `explain`. It matches only a token that
is exactly one of the command's long flags (or its `--flag=value` spelling);
short aliases such as `-u` pass through as RouterOS input. If RouterOS really
needs such a token, put it inside the quoted command. Password values are
replaced by `<password>` in the printed command line.
Credentials embedded in a positional target or a `--host` value are redacted
to `***@host`, including when `--host` is moved before the separator.
Explicit URL userinfo is redacted even when its colon is percent-encoded;
bare CDB identities such as `rtr@site` remain unchanged.

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) for the centrs error
contract.
