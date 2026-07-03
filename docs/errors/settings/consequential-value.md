# `settings/consequential-value`

`settings set` accepted a syntactically valid value with a real, non-obvious consequence (e.g. a global --insecure default, or a transfer-via value gated elsewhere).

## Fix

This is a warning, not a failure — the envelope is still `ok: true` and the
value is written. `centrs settings set` emits it for exactly two keys today
(the `warn` callback on the matching `SettingsKeyDef` in `src/settings.ts`):

- `insecure` set to any truthy spelling (`true`, `yes`, `on`, `1`) makes
  every command run without an explicit `--insecure`/`--no-insecure`
  override trust RouterOS's self-signed TLS certificate or unknown SSH host
  key globally, not just for one invocation. See the `insecure` row in
  `commands/settings/README.md`'s "Known settings keys" table.
- `transfer-via` set to `ftp` is accepted here — `ftp` is a syntactically
  valid `CENTRS_TRANSFER_VIA` value — but `transfer` still rejects it at
  call time with [`settings/unsafe-protocol-blocked`](unsafe-protocol-blocked.md)
  unless `ALLOW_UNSAFE_PROTOCOLS` also includes `ftp`. The warning exists so
  the write doesn't silently look like it "worked" when the value won't
  actually take effect anywhere else yet.

There is nothing to fix in the sense of retrying with different input — the
value you asked for was written as requested. Run `centrs settings set
insecure false` or pick a different `transfer-via` value if the consequence
wasn't intended. See example 24 in `commands/settings/examples.md`.
