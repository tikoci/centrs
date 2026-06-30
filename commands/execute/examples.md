# execute — examples

Each numbered example is an executable spec, run against a CHR 7.23 router booted
by `@tikoci/quickchr`: `test/integration/execute.test.ts` covers examples 1–11
over REST and 12–18 over the native API; `test/integration/mac-telnet-console.test.ts`
covers examples 19–21 over mac-telnet (real L2 via the `socket-connect` bridge).
If a line here is not exercised by a test, the test file is wrong; if a line
passes only with `validate=false`, the **implementation** is wrong (see
`docs/CONSTITUTION.md`).

`$R` is `<host>:<rest-port>` resolved by quickchr. `$A` is `<host>` and
`$API_PORT` is the native API port (`chr.ports.api`). `$MAC` is the device MAC and
`$MT_HOST`/`$MT_PORT` are the mac-telnet UDP delivery endpoint (the loopback L2
bridge in CI). `$U` / `$P` are CHR credentials provided by the test harness.
`$ID` is the `.id` returned by the preceding add example in the same transport
section.

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

## mac-telnet (`--via mac-telnet`)

Layer-2 execute over the RouterOS interactive console (UDP/20561). `$MAC` is the
device MAC; `$MT_HOST`/`$MT_PORT` are the UDP delivery endpoint (L2 broadcast in
the field, the `quickchr` loopback L2 bridge in CI). Validation over mac-telnet
is a **single console `:put [:parse …]`** — it reports both `syntax error` and
`bad parameter <name>`, so it covers the syntax *and* the unknown-attribute gate
at once (no `/console/inspect` table parsing). The console opens through a
first-login license screen (auto-answered) and a ~10s terminal-negotiation stall;
**a successful write prints nothing** over the console (no `.id`/`ret`, unlike
REST/native). Examples 19–21 are green via `bun run test:integration`
(`test/integration/mac-telnet-console.test.ts`, CHR 7.23.1) over the real L2
bridge; the console reader is also exercised directly in the same test.

### 19. Read a command over mac-telnet

```bash
centrs execute $MAC '/system/identity/print' --via mac-telnet --host $MT_HOST --port $MT_PORT --username $U --password $P
```

Envelope: `ok: true`, `meta.via=mac-telnet`, `data.ret` is the console output and
contains the device identity (cross-checked against REST). `meta.validation.source`
is `:put [:parse ...] over mac-telnet`.

### 20. Write (add) over mac-telnet

```bash
centrs execute $MAC '/ip/address/add address=198.51.100.40/32 interface=ether1' --via mac-telnet --host $MT_HOST --port $MT_PORT --username $U --password $P --yes
```

Envelope: `ok: true`, `meta.via=mac-telnet`, `data.ret` is empty (a successful
console write prints nothing — there is no `.id` to return). A subsequent REST
read of `/ip/address` shows `198.51.100.40`.

### 21. Validation rejects an unknown attribute over mac-telnet

```bash
centrs execute $MAC '/ip/address/add address=198.51.100.41/32 interface=ether1 no-such-arg=x' --via mac-telnet --host $MT_HOST --port $MT_PORT --username $U --password $P --yes
```

Envelope: `ok: false`, `error.code=validation/unknown-attribute`,
`meta.via=mac-telnet`, and no address is added — the console `:parse` gate
catches `no-such-arg` before any mutation.

## ssh (`--via ssh`)

Execute over the RouterOS SSH server using the **host `ssh`** client. RouterOS
grants no pseudo-tty, but `ssh user@host "<command>"` runs one single-line console
command and returns **clean** output (no prompt, no ANSI, no echo) — so each
execute is one `ssh` invocation (a fresh login, like the SFTP batch client), and
the only post-processing is trimming the console's column padding. Validation is
the **same single console `:put [:parse …]`** as mac-telnet (over SSH it returns
the identical `(evl …)` / `bad parameter <name>` strings), so syntax and the
unknown-attribute gate are covered at once. Key auth is the path (`--ssh-key` /
agent); `--insecure` accepts the device's host key. `$SSH_PORT` is the SSH port,
`$KEY` the private key. Examples S1–S4 are green via `bun run test:integration`
(`test/integration/execute-ssh.test.ts`, CHR 7.23.1).

### S1. Read a command over ssh

```bash
centrs execute 127.0.0.1 '/system/identity/print' --via ssh --port $SSH_PORT --username $U --ssh-key $KEY --insecure
```

Envelope: `ok: true`, `meta.via=ssh`, `data.ret` is the cleaned console output and
contains the device identity (cross-checked against REST). `meta.validation.source`
is `:put [:parse ...] over ssh`.

### S2. Multi-line read returns cleaned, column-aligned output

```bash
centrs execute 127.0.0.1 '/system/resource/print' --via ssh --port $SSH_PORT --username $U --ssh-key $KEY --insecure
```

Envelope: `ok: true`; `data.ret` contains the running RouterOS version (each line
trimmed of trailing padding, CRLF normalized).

### S3. Write (add) over ssh

```bash
centrs execute 127.0.0.1 '/ip/address/add address=198.51.100.50/32 interface=ether1' --via ssh --port $SSH_PORT --username $U --ssh-key $KEY --insecure --yes
```

Envelope: `ok: true`, `meta.via=ssh`, `data.ret` empty (a successful console write
prints nothing). A subsequent REST read of `/ip/address` shows `198.51.100.50`.

### S4. Validation rejects an unknown attribute over ssh

```bash
centrs execute 127.0.0.1 '/ip/address/add address=198.51.100.51/32 interface=ether1 bogus=x' --via ssh --port $SSH_PORT --username $U --ssh-key $KEY --insecure --yes
```

Envelope: `ok: false`, `error.code=validation/unknown-attribute`, `meta.via=ssh`,
and no address is added — the console `:parse` gate catches `bogus` pre-mutation.

## Target selection (fan-out)

These exercise the shared target-selection grammar
([`docs/CONSTITUTION.md` → Target selection grammar](../../docs/CONSTITUTION.md#target-selection-grammar)),
run by `test/integration/execute-fanout.test.ts` when CHR integration is enabled.
`$CDB` has two records in group `fanout-chr`: record 0 is the live CHR (comment
fact `role=edge`) and record 1 is an unreachable REST URL (`role=core`). Note the
execute `--` boundary: targets/selectors come before it, the command after.

### F1. Group fan-out of a read command

```bash
centrs execute --group fanout-chr --via rest-api --cdb-file $CDB --json -- /system/resource/print
```

`ok: true`, `data.summary = { total: 2, ok: 1, failed: 1 }`, targets ordered by
`recordIndex`, `meta.operation.kind = fanout`; the unreachable target is an inner
`ok: false` (`transport/connection-refused`). Process exit `2`.

### F2. Empty / unknown group

```bash
centrs execute --group no-such-group --via rest-api --cdb-file $CDB --json -- /system/resource/print
```

`ok: true`, `data.summary = { total: 0, ok: 0, failed: 0 }`,
`warnings` include `cdb/empty-group`. Exit `0`.

### F3. `--where` device-class selector (subset)

```bash
centrs execute --where role=edge --via rest-api --cdb-file $CDB --json -- /system/resource/print
```

Selects only record 0: `data.summary = { total: 1, ok: 1, failed: 0 }`,
`meta.operation.selection.where = ["role=edge"]`, exit `0`.

### F4. `--all` (every CDB record)

```bash
centrs execute --all --via rest-api --cdb-file $CDB --json -- /system/resource/print
```

`data.summary = { total: 2, ok: 1, failed: 1 }`,
`meta.operation.selection.all = true`, exit `2`.

### F5. Write-shaped fan-out without `--yes` is refused (blast radius)

```bash
centrs execute --group fanout-chr --via rest-api --cdb-file $CDB --json -- /system/identity/set name=fanout-blast
```

A write-shaped fan-out is gated once up front: `ok: false`,
`error.code = usage/confirmation-required`, the summary names the blast radius
(`2 router(s)`), exit `1`. Nothing is mutated. Add `--yes` to fan the write out.

### F6. Multiple positional targets (ad-hoc literals) before `--`

```bash
centrs execute $REACHABLE_URL $UNREACHABLE_URL --via rest-api --username $U --password $P --json -- /system/resource/print
```

More than one positional target is fan-out mode (the `--` separates them from the
command). With no `--cdb-file`, both are ad-hoc literals, labeled by
`meta.target.input` with no `recordIndex`: `data.summary = { total: 2, ok: 1,
failed: 1 }`, exit `2`.

## Protocol selection notes

For an unresolved MAC target, execute auto-selection defaults to mac-telnet
rather than ARP-based IP resolution:

```bash
centrs execute $MAC '/system/identity/set name=chr-via-mac' --username $U --password $P --yes
```

Envelope: `meta.via=mac-telnet` when `$MAC` is not resolved from CDB and no
`--via` is pinned (delivery defaults to L2 broadcast; override with
`--host`/`--port`). If the caller wants IP-level REST or native API execution,
they must opt into MAC-to-IP resolution (`--resolve arp` + `--via …`) before
protocol selection.
