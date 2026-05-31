# execute — examples

Each numbered example is an executable spec. The integration tests under
`test/integration/rest-execute.test.ts` and
`test/integration/native-api-execute.test.ts` run these examples against a CHR
7.23 router booted by `@tikoci/quickchr`. If a line here is not exercised by a
test, the test file is wrong; if a line passes only with `validate=false`, the
**implementation** is wrong (see `docs/CONSTITUTION.md`).

`$R` is `<host>:<rest-port>` resolved by quickchr. `$A` is `<host>` and
`$API_PORT` is the native API port (`chr.ports.api`). `$U` / `$P` are CHR
credentials provided by the test harness. `$ID` is the `.id` returned by the
preceding add example in the same transport section.

All write-shaped examples use `--yes` as the explicit non-interactive
confirmation flag. Without `--yes`, non-TTY writes fail before validation or any
RouterOS mutation; with a TTY, the CLI prompts before running the write.

## rest-api (`--via rest-api`)

### 1. Add an address with structured path-POST

Must succeed with `validate=true` (default). The CLI canonicalizes the command
as path `/ip/address`, verb `add`, and attributes `address`, `interface`, and
`comment`; the REST adapter uses the structured path-command endpoint rather
than script mode.

```bash
centrs execute $R '/ip/address/add address=198.51.100.10/32 interface=ether1 comment="centrs-execute-rest"' --via rest-api --username $U --password $P --yes
```

Envelope: `ok: true`, `data.ret` is a RouterOS internal id matching `/^\*[0-9A-F]+$/`,
`data[".id"]` carries the same value for downstream set/remove examples,
`meta.via=rest-api`, and `meta.validation.source` includes both
`:put [:parse ...]` and `/console/inspect`.

### 2. Set the address by `.id`

```bash
centrs execute $R "/ip/address/set numbers=$ID comment=centrs-execute-rest-set" --via rest-api --username $U --password $P --yes
```

Envelope: `ok: true`, `data` is empty or contains the RouterOS success record,
`meta.via=rest-api`, and re-reading `/ip/address/$ID` shows
`comment="centrs-execute-rest-set"`.

### 3. Remove the address by `.id`

```bash
centrs execute $R "/ip/address/remove numbers=$ID" --via rest-api --username $U --password $P --yes
```

Envelope: `ok: true`, `meta.via=rest-api`. A subsequent retrieve of
`/ip/address` does not contain `$ID`.

### 4. Run a non-path-shaped console command through `/rest/execute`

The command is a script-shaped console expression, not a slash path plus verb,
so REST must use the `/rest/execute` fallback.

```bash
centrs execute $R ':put [/system/identity/get name]' --via rest-api --username $U --password $P
```

Envelope: `ok: true`, `data` is string-shaped (`data.output` or `data.ret`) and
contains the CHR identity name, `meta.via=rest-api`, and
`meta.validation.syntax=true`. `meta.validation.semantic` is absent or marked
`not-applicable` because `/console/inspect` validates path-shaped commands, not
arbitrary script expressions.

### 5. Syntax reject from `:put [:parse ...]`

Malformed CLI is rejected by the syntax gate before semantic validation or the
write round-trip.

```bash
centrs execute $R '/ip/address/add address="unterminated interface=ether1' --via rest-api --username $U --password $P --yes
```

Envelope: `ok: false`, `error.code=validation/syntax`, `error.cause` preserves
the RouterOS parse error string from `:put [:parse ...]`, `meta.via=rest-api`,
and no address is added.

### 6. Semantic reject that `:parse` accepts

Grounded on CHR 7.23: `:put [:parse "/ip/address/add no-such-arg=x"]` accepts
unknown attributes, so centrs must not treat a clean parse as semantic success.
`/console/inspect` rejects the attribute before the write.

```bash
centrs execute $R '/ip/address/add address=198.51.100.11/32 interface=ether1 no-such-arg=x' --via rest-api --username $U --password $P --yes
```

Envelope: `ok: false`, `error.code=validation/unknown-attribute`,
`error.cause.attribute="no-such-arg"` (or equivalent structured field),
`meta.validation.syntax=true`, `meta.validation.source=/console/inspect`, and
no address is added. This example is the product claim: syntax validation and
semantic validation are separate gates.

### 7. RouterOS error on `/rest/execute` HTTP 200

Assumption to verify on CHR 7.23: a script-mode RouterOS `:error` returns HTTP
200 from `/rest/execute` with a RouterOS failure string in the body. That body is
still a failed RouterOS result, not successful command output.

```bash
centrs execute $R ':error "centrs execute fixture trap"' --via rest-api --username $U --password $P
```

Envelope: `ok: false`, `error.code=routeros/command-failed` (or the more
specific grounded `routeros/*` mapping for the returned string),
`error.cause` preserves the original RouterOS string, and `meta.via=rest-api`.
This uses the same mapping table as native API `!trap` errors.

### 8. Pinned REST has no silent downgrade

`/rest/execute` is required for arbitrary script-shaped commands over REST. If
that capability is unavailable or disabled, `--via rest-api` must fail instead
of silently trying native API, SSH, or mac-telnet.

```bash
centrs execute $R ':put "requires rest execute"' --via rest-api --username $U --password $P
```

Envelope when REST cannot perform the operation: `ok: false`,
`error.code` starts with `transport/`, `meta.via=rest-api`, and
`meta.warnings` does not contain a protocol-downgrade warning. When REST can
perform it, the command succeeds over REST and still does not downgrade.

### 9. Non-TTY write without `--yes` is refused

```bash
centrs execute $R '/ip/address/add address=198.51.100.12/32 interface=ether1 comment="missing-confirm"' --via rest-api --username $U --password $P </dev/null
```

Envelope: `ok: false`, `error.code=usage/confirmation-required`,
`meta.via=rest-api`, no validation transport call is made, and no address is
added.

### 10. TTY write prompts before mutation

```bash
centrs execute $R '/ip/address/add address=198.51.100.13/32 interface=ether1 comment="tty-confirm"' --via rest-api --username $U --password $P
```

When stdin is a TTY, the CLI prompts for write confirmation. Answering `no` (or
EOF) returns `ok: false` with `usage/confirmation-required` and no mutation;
answering `yes` continues to validation and the write, returning the same
success envelope shape as example 1.

### 11. `--validate=false` probes without preflight gates

This escape hatch skips centrs syntax and semantic preflight validation but does
not suppress RouterOS errors from the write round-trip.

```bash
centrs execute $R '/ip/address/add address=198.51.100.14/32 interface=ether1 no-such-arg=x' --via rest-api --username $U --password $P --yes --validate=false
```

Envelope: `ok: false`, `error.code=routeros/unknown-attribute` (or the grounded
RouterOS `routeros/*` code for `unknown parameter no-such-arg`),
`error.cause` preserves the original RouterOS string, `meta.via=rest-api`, and
`meta.validation.enabled=false`.

## native-api (`--via native-api`)

The same execute contract over the RouterOS binary API. Validation still runs
through `:put [:parse ...]` and `/console/inspect`, issued as native API
commands. Attribute values are strings because the binary API does not carry
JSON scalar types.

### 12. Add an address with native `talk`

```bash
centrs execute $A '/ip/address/add address=198.51.100.20/32 interface=ether1 comment="centrs-execute-api"' --via native-api --port $API_PORT --username $U --password $P --yes
```

Envelope: `ok: true`, `data[".id"]` (or `data.ret`) is the new RouterOS
internal id, `meta.via=native-api`, and `meta.validation.source` includes both
`:put [:parse ...]` and `/console/inspect`.

### 13. Set the native-created address by `.id`

```bash
centrs execute $A "/ip/address/set numbers=$ID comment=centrs-execute-api-set" --via native-api --port $API_PORT --username $U --password $P --yes
```

Envelope: `ok: true`, `meta.via=native-api`, and re-reading `/ip/address/$ID`
shows `comment="centrs-execute-api-set"`.

### 14. Remove the native-created address by `.id`

```bash
centrs execute $A "/ip/address/remove numbers=$ID" --via native-api --port $API_PORT --username $U --password $P --yes
```

Envelope: `ok: true`, `meta.via=native-api`. A subsequent retrieve of
`/ip/address` does not contain `$ID`.

### 15. Native syntax reject from `:parse`

```bash
centrs execute $A '/ip/address/add address="unterminated interface=ether1' --via native-api --port $API_PORT --username $U --password $P --yes
```

Envelope: `ok: false`, `error.code=validation/syntax`, `error.cause` preserves
the RouterOS parse error string, `meta.via=native-api`, and no address is added.

### 16. Native semantic reject after clean parse

```bash
centrs execute $A '/ip/address/add address=198.51.100.21/32 interface=ether1 no-such-arg=x' --via native-api --port $API_PORT --username $U --password $P --yes
```

Envelope: `ok: false`, `error.code=validation/unknown-attribute`,
`meta.validation.syntax=true`, `meta.validation.source=/console/inspect`, and
no address is added. The failure must be classified as validation, not as a
native API `!trap`, because the semantic gate catches it before the write.

### 17. Native `!trap` uses the shared RouterOS error table

With validation disabled, the unknown attribute reaches RouterOS and native API
returns a `!trap` message.

```bash
centrs execute $A '/ip/address/add address=198.51.100.22/32 interface=ether1 no-such-arg=x' --via native-api --port $API_PORT --username $U --password $P --yes --validate=false
```

Envelope: `ok: false`, `error.code=routeros/unknown-attribute` (the same code as
REST for the same RouterOS string), `error.cause` preserves the original
`!trap` message, `meta.via=native-api`, and `meta.validation.enabled=false`.

### 18. Native non-TTY write without `--yes` is refused

```bash
centrs execute $A '/ip/address/add address=198.51.100.23/32 interface=ether1 comment="api-missing-confirm"' --via native-api --port $API_PORT --username $U --password $P </dev/null
```

Envelope: `ok: false`, `error.code=usage/confirmation-required`,
`meta.via=native-api`, no validation command is sent, and no address is added.

## Protocol selection notes

For an unresolved MAC target, execute auto-selection defaults to mac-telnet
rather than ARP-based IP resolution:

```bash
centrs execute $MAC '/system/identity/set name=chr-via-mac' --username $U --password $P --yes
```

Envelope: `meta.via=mac-telnet` when `$MAC` is not resolved from CDB and no
`--via` is pinned. If the caller wants IP-level REST or native API execution,
they must opt into MAC-to-IP resolution before protocol selection. This note is
not part of the rest-api/native-api CHR gate until the L2 mac-telnet harness is
available.
