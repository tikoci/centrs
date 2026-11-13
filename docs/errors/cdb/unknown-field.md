# `cdb/unknown-field`

A warning: a device record holds CDB fields centrs cannot decode, usually
ones a newer WinBox wrote. centrs keeps them byte for byte, and writes them
back unchanged when it saves the record.

## Emitted by

`devices` commands that read or rewrite such a record *(code)*.

## Context

- `target`: the device, when one record is named.
- `tags`: the tags of the fields centrs could not decode.
- `mayContainPassword`: true when those bytes may hold the record's
  password. Then `passwordSet` may say there is no password when there is
  one.
- `cdbFile`: the CDB, on a rewrite.

## Fix

Nothing is needed to keep the record intact: the fields round-trip. If
`mayContainPassword` is set, `devices show` may report no password when one
is stored, and centrs cannot use that password to log in, because it cannot
read it. If logins to this device fail, give the password another way: see
[`tip/credentials-missing`](../../tips/credentials-missing.md).
If a WinBox release keeps producing these, open an issue with the WinBox
version, `tags` and `centrs --version`. Do not attach the CDB: it holds
credentials.
