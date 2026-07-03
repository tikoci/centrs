# `settings/invalid-via`

An unsupported protocol identifier was supplied to --via.

## Fix

This one code covers two different value sets, because `settings` reuses it
for two different keys. `centrs settings set via <value>` requires one of
the protocol identifiers in `plannedProtocols` (`src/protocols/index.ts`):
`rest-api`, `native-api`, `ssh`, `snmp`, `mndp`, `mac-telnet`, `romon`,
`winbox-terminal` — `centrs settings set via carrier-pigeon` is the
canonical trigger (example 21 in `commands/settings/examples.md`).
`centrs settings set transfer-via <value>` reuses the same error code but
validates against a completely different set: `auto`, `rest`/`rest-api`,
`native`/`native-api`, `sftp`, `scp`, `fetch`, `ftp`. Unlike `CENTRS_VIA`,
which has a per-device `via=` comment-kv counterpart, `CENTRS_TRANSFER_VIA`
has none — `transfer` reads only the env var.

The same validation backs `retrieve`/`execute`/`api`'s own `--via` flag more
broadly, so the identical code and message shape appear there too, not only
through `settings set`.

`transfer-via ftp` is syntactically valid against the `transfer-via` set
above — it does **not** trigger this error — but it does trigger a separate
warning, [`settings/consequential-value`](consequential-value.md), because
`transfer` still rejects `ftp` at call time unless `ALLOW_UNSAFE_PROTOCOLS`
also opts in. See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) (Protocol
selection) for the full `via` vocabulary.
