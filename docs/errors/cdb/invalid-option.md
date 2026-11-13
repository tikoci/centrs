# `cdb/invalid-option`

A warning: a saved device has a device property whose value centrs cannot
use, such as `via=foo` or `port=abc`. centrs ignores it, and the setting
comes from the next source: an environment variable, the config file, or the
default.

## Context

- `key`, `value`: the property and its value.
- `recordIndex`: the device record.

## Fix

Set a valid value with `centrs devices set <router> <key>=<value>`, or
remove the property with `<key>=` (no value). `centrs devices show <router>`
shows what the device resolves to.

## Related

- [`cdb/unknown-option`](unknown-option.md): a key that is not a device
  property at all.
