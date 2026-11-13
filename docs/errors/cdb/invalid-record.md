# `cdb/invalid-record`

A device record failed validation before it was written: a blank target, or
a field of the wrong type. Nothing was written.

## Emitted by

`devices add` and `set`, the MCP `centrs_devices` tool, and library callers
of the device mutation API *(code)*. The CLI checks most of this earlier, so
this code mostly reaches MCP and library callers.

## Context

- `field`: the first field that failed, or `(record)` when the input was not
  a record object at all.
- `causeData`: every validation issue, as `path`, `code` and `message`.

## Typical triggers

- An empty or whitespace-only `target` *(code)*.
- A non-string `user`, `password`, `group`, `profile`, `session` or
  `comment`, or a non-boolean `savedPassword` *(code)*.
- A `recordType` that is not a non-negative integer *(code)*.

## Fix

Correct the field named in `context.field`; `remediation` says what it must
be. `causeData` lists every issue, not only the first.
