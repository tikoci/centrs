# `usage/missing-flag-value`

A value-taking CLI flag has no following value, or the next token is another
flag. The error context names `flag` and `got` (`null` at the end of argv).

For example, `centrs terminal --quickchr` needs a machine name, and
`centrs retrieve --host --json /ip/address` needs a host before `--json`.
These errors occur before target resolution or any router connection.

## Fix

Supply the value named in the remediation: `--quickchr <name>` or
`--host <host>`. Long options also accept `--flag=value`.

A bare `--` ends option parsing, so put required option values before it.
`--help` or `-h` before the separator shows help, including after an incomplete
flag such as `--quickchr --help`.

Password flags accept flag-shaped values and explicit empty values. Use an
attached value such as `--password=--help` when the password is a help token.
Negative numbers and the stdin marker `-` remain values for the individual
option to validate.
