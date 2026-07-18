# `routeros/version-unsupported`

The device's RouterOS version does not provide the operation this command
needs. centrs pre-flighted the generated command against the device's known
version (a live read, or the stored CDB `version=` fact) and refused it before
touching the router, instead of letting the device return a raw protocol
error.

Distinct from `routeros/unsupported-capability`, where the chosen *protocol*
cannot carry the operation at all regardless of device version.

## Context fields

- `capability` — stable slug of the missing operation.
- `version` — the device version that was checked.
- `versionSource` — `live`, `cdb-fact`, or `caller`. A `cdb-fact` version is
  stale-by-nature; it was recorded by `discover --save` or `devices --check`.
- `supported` — the version windows where RouterOS provides the operation
  (inclusive `min`, optional exclusive `maxExclusive` for backport windows).

## Fix

Upgrade RouterOS to one of the versions listed in `supported`. If the device
was already upgraded and the check used a stale stored fact
(`versionSource: "cdb-fact"`), refresh the record's `version=` comment fact
and retry.
