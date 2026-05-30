# discover

Discover RouterOS neighbors and optionally save them into the CDB.

Status: `not-started`. This file anchors the `discover --save` direction; the
matrix remains the only status surface.

## Synopsis

```text
centrs discover [--timeout 60s] [--save] [--group discovered] [flags]
```

## Intent

- MNDP is the first discovery source. It is a passive hint source, not
  authoritative inventory.
- `--save` writes discovered targets into the configured CDB with provenance
  metadata in comment kv-soup and default `group=discovered`.
- Saved records must preserve enough metadata for later resolution: MAC,
  advertised identity, platform, RouterOS version when present, source, and
  discovery timestamp.
- Discovery never supplies credentials. A later `retrieve`, `execute`, or
  `devices edit` must still resolve credentials from CDB, env, CLI, or prompt.

## Open questions

- MNDP cache shape, TTL, and merge policy when a discovered device already has
  a first-class CDB record.
- CHR/L2 test scheme for CI; likely belongs in `@tikoci/quickchr`.
