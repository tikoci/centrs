# execute

Run a RouterOS CLI command and return its (semi-structured) output. `execute`
is the single read/write surface for RouterOS configuration and operational
CLI-shaped commands — there is no separate `update` command.

Status: `rest-api`, `native-api`, `mac-telnet`, and `ssh` are `CHR-passed` (see
`docs/MATRIX.md` and `commands/execute/examples.md`, examples 1–11 over REST,
12–19 over the native API, 20–22 over mac-telnet, and S1–S5 over ssh, green via
`bun run test:integration`), including multi-target fan-out (see **Target
selection**, examples F1–F5). `romon` and `winbox-terminal` remain
`not-started`. SNMP is retrieve-only and rejects `execute`.

## Intent

- Mirror RouterOS `execute` semantics. Input is a CLI string; output is
  console-shaped text (or structured records for path+verb writes) wrapped in
  the standard envelope. This includes selector-, positional-id-, and
  non-CRUD-shaped writes.
- Validation runs **offline first, then on the device** (see constitution:
  validation; GH#354). Stage 1 is the corpus-gated analyzer over the exact
  command string, with no connection: a syntax fault is rejected with a byte
  span in `error.context.span` and the adapter is never dialed, and
  `meta.validation.stages[]` then shows the device stage `skipped`. Stage 1
  cannot see an unknown attribute — it has no per-menu schema — so stage 2 is
  not optional.
- Stage 2 is itself two gates (grounded on CHR 7.23.3,
  GH#230): a single `:put [:parse "<cmd>"]` covers both the syntax and the
  unknown-attribute (name-level) gate on **every** transport — `:parse` never
  throws; its return value's printed form (`(evl …)` / `(evl bad parameter …)` /
  `(<%% bad command name …)`, or a bare line-anchored `syntax error` /
  `expected …` / `missing … (line N column M)`, examples V4) is read from the
  REST/native `ret` *and* the console output. An accepted return can echo
  those words, so only the anchored forms reject. That check is necessary, not sufficient: value-type errors pass
  it, and the `/console/inspect request=child` / server re-validation semantic
  checks are separate. Command-level `request=completion` is deliberately not
  used: it hangs REST and closes native API on RouterOS 7.12.2 (GH#343), while
  `child` returns the complete argument-name set immediately.
  The outer RouterOS string literal escapes backslash, quote, and dollar so
  validation parses the caller's exact command rather than expanding variables
  in the wrapper.
- centrs owns the **script-vs-structured gate** (`canonicalizeExecuteCommand` in
  `src/execute.ts`): it decides which validation and transport path runs.
  `isWriteShaped` is deliberately independent: script fallback for `[find]`, a
  positional id, or other non-`key=value` input never bypasses confirmation.
  Known read verbs are allowlisted; an unknown menu verb fails closed as a
  write-shaped operation. In script mode every command head in a statement
  (the statement start and each `[…]` or `{…}` body) must be a read: its verb
  is the first word past the known menu prefix, so `/ip address print` is a
  read and `/user expire-password print` is not (examples W3). Script
  directives that only output, branch or compute a value are reads, including
  the pure functions `:serialize`, `:deserialize`, `:convert`, `:delay`,
  `:find`, `:timestamp`, `:rndnum`/`:rndstr` and the `:to*` converters, and the
  `{…}`-bodied `:retry` and `:time` (example W4, #458). The absolute
  `/serialize` spelling counts too; a bare `serialize` keeps the menu-verb rule,
  because after navigation it could name a menu command. RouterOS runs only a
  `{…}` block in a script-typed argument, so every body is visible to the gate.
  Root mutators such as `/import` and indirect
  execution through `:execute` are write-shaped too, as are `:global`, `:set`
  and `:parse`, and so is any command carrying `file=` or `file-name=`
  (including argument prefixes such as `fi=` and `file-n=`, example W5):
  RouterOS redirects output into a device file, so
  `/ip/address/export file=address` creates `address.rsc`,
  `/file/print file=test` creates `test.txt` and `:serialize … file-name=x`
  creates `x`, even though `export`, `print` and `:serialize` are reads. The shared
  `rosetta`/`lsp-routeros-ts`
  canonicalizer is for canonicalization only — never the structured predicate
  (widening `structured` is a product regression). Pinned by
  `test/unit/execute-canonicalize-contract.test.ts`; the parser-vendoring
  preconditions live in the `canonicalizeExecuteCommand` doc-comment.
- REST adapter prefers structured path-POST when the CLI canonicalizes to
  path+verb+attrs (`POST /rest/<path>/<verb>` → `{"ret":"<.id>"}`, clean typed
  errors); falls back to `POST /rest/execute {"script":"<cli>"}` for
  non-path-shaped console commands.
- **RouterOS REST verb mapping — the `POST` ≠ `add` trap (surfaced explicitly).**
  RouterOS REST maps `GET`→print, **`PUT`→add**, `PATCH`→set, `DELETE`→remove,
  and `POST`→the *universal* "run any console command" method ([REST API → HTTP
  Methods](https://help.mikrotik.com/docs/spaces/ROS/pages/47579162/REST%2BAPI#RESTAPI-HTTPMethods)).
  So the naive REST assumption `POST`=create is **wrong** — `PUT` is RouterOS's
  create. centrs sidesteps the trap with the explicit verb-in-path form
  `POST /rest/<path>/<verb>` (e.g. `POST /rest/ip/route/add`): add/set/remove are
  **named**, never inferred from the HTTP method. The mapping is documented here
  so the trap is impossible to miss at centrs's `api` surface.
- native-api adapter issues the same write as a tagged `talk` sentence; its
  `!trap` strings share one error table with REST `detail`. REST and native
  classify the same RouterOS fault to the same `routeros/*` code: both feed the
  router-side fault string through `mapRouterOsError`
  (`src/core/routeros-errors.ts`). In `RestAdapter.mapHttpFailure`
  (`src/protocols/adapter.ts`), transport-level HTTP statuses are classified
  first — 401/403 → `transport/auth-failed`, 5xx → retryable
  `transport/connection-closed` (kept distinct so the fanout retry allowlist
  can retry drops without retrying real router rejections) — and everything
  else passes its `detail`/body plus the HTTP status through
  `mapRouterOsError({ transport: "rest-api", httpStatus })`. There is no longer
  a hand-rolled `routeros/*` table on the REST side.
- **Run-time fault mapping.** A successful transport can still carry a RouterOS
  rejection in `/execute`'s `ret`. Result detection lives beside the grounded
  mappings in `src/core/routeros-errors.ts`, uses anchored result shapes so
  ordinary output containing error-like prose remains output, and preserves a
  passed validation history while failing the overall envelope.
- Output is *string*-shaped for script-mode; richer parsing is a future
  concern. The envelope must still distinguish RouterOS errors from successful
  runs (a 200 with a RouterOS error string is still an error — see
  constitution: error model).
- **Print width / column wrapping (JG-04).** RouterOS wraps `print` output to the
  terminal width, so each transport handles width differently. **mac-telnet** is
  the only one that negotiates a size: `src/protocols/mac-telnet-console.ts`
  answers the device's terminal-size probe with a deliberately tall/wide screen,
  so captured columns are neither paginated nor wrapped *at the negotiated
  width*. **SSH execute** runs *without* a pseudo-tty (`src/protocols/ssh.ts`),
  so no width is negotiated at all. **REST/native-api** are not consoles, so a
  terminal width never applies (they return structured records, or a string
  `ret` for script-mode). There is therefore no per-call `--width` knob today —
  an explicit width override is deferred until a concrete need appears.
- **A device-side wrap that no width negotiation reaches (GH#352).** Declaring a
  width is not sufficient, because RouterOS can wrap for reasons that are not
  about width. On 7.23.6 / 7.24.3 / 7.25beta4 a settings menu with exactly one
  property prints its value **one character per line**: `/system/identity/print`
  returns `name: C` / `H` / `R` where 7.24.2 returns `name: CHR`. Measured on
  stock CHR, the wrap is identical over REST `POST /rest/execute`, over
  `ssh user@host "<cmd>"`, and over the mac-telnet console — including the
  mac-telnet reader that has already answered the size probe with 512 columns,
  and the ssh client that negotiates nothing. The console login modifiers
  (`+c512w200h`, `+ct`, `+e`) do not change it, and it is not proportional to
  the value's length. Every multi-property `print` is unaffected on the same
  build, as is `:put [/system/identity/get name]`.

  Consequence for this command: `data.ret` carries the device's console text
  **verbatim**, wrap included — centrs cannot tell a layout newline from
  content, and inventing a de-wrapper would corrupt legitimate output. Callers
  that need a value rather than a rendering should read it structurally
  (`retrieve`, or `api`) or ask the device for the scalar
  (`:put [<menu>/get <property>]`). The integration examples compare identities
  with `print` column wrapping collapsed for this reason — see
  `collapsePrintWrapping` in `test/integration/chr.ts`.
- Attribute values pass through **verbatim** — centrs does not guess types or
  coerce them (RouterOS REST tolerates string values; the native API is
  all-strings). Unlike `jo`-style KV builders, there is no per-value
  type-forcing escape, because the device, not centrs, owns value typing.
- On an empty-CDB resolution failure, execute (like retrieve) emits the
  `tip/no-devices` tip, steering toward `centrs devices discover` /
  `centrs settings`.
- Protocol surfaces are native API, REST, mac-telnet, and SSH. RoMON and
  WinBox Terminal are later. SNMP is retrieve-only and must reject execute.
- For a MAC target not resolved from CDB, auto-selection defaults to
  mac-telnet. Callers that want IP-level execution may opt into ARP-based
  MAC → IP resolution with `--resolve arp` (plus `--via native-api`/`rest-api`)
  before protocol selection.
- An explicit `http(s)://host[:port]` target (positional, `--host`, or
  `CENTRS_HOST`) names the REST service: with no `via` pinned anywhere,
  auto-selection picks `rest-api` and keeps the URL's scheme and port
  (`meta.settings.via` source `default` / `via:target-url`). Otherwise
  auto-selection picks native-api. On the IP transports (native-api, REST,
  ssh), a port typed into the target (`host:port`, `http://host:port`,
  including an explicit `:80`/`:443`) is honored. The port settings ladder
  (`--port`, `CENTRS_PORT`, a CDB `port=` comment, config) wins over it, and
  the transport default comes last. The port carried by a matched CDB
  record's `target` is not applied to native-api. mac-telnet addresses the MAC,
  so its `--host`/`--port` are only the UDP delivery endpoint.
- When the resolved transport is mac-telnet and **no** username or password is
  resolved from any source, execute emits a `tip/mac-telnet-no-credentials`
  pointer: mac-telnet logs in with RouterOS credentials over **MTWEI** (MD5 is
  refused by current RouterOS), so an empty login is rejected at connect time.
  It is a tip, not an error — the call is still attempted.
- Default output is human-readable `text`; pass `--json`/`--format json`
  (or set `CENTRS_FORMAT=json`) for the structured envelope. In text mode every
  command renders errors the same way (`formatCentrsErrorText`): `[code] summary`,
  then `At:` (RouterOS position or offline byte span), `Device said:` (RouterOS's
  own words), `Fix:` and `Details:` when present. `--verbose` adds the full
  `context`.
- CDB comment-kv metadata may provide per-target `via`, `port`, and `ssh-key`
  overrides; CLI/API arguments still win.
- RoMON and WinBox Terminal are lower priority than mac-telnet until their
  validation, tooling, and CI story are grounded.

## Flags

Implemented flags are generated from the CLI metadata into
[`docs/CLI.md` → execute](../../docs/CLI.md#execute); this file does not
duplicate that table. Behavior notes the generated reference cannot carry:

- `--validate` is transport-appropriate but now one gate on every transport —
  a single `:put [:parse ...]` that is read as a value (GH#230): REST/native
  read the `ret` text (HTTP 200 / `as-string`); mac-telnet and ssh read the
  console's printed value.
- `--format` defaults to `text`; `CENTRS_FORMAT` sets the default.
- `--quickchr` resolves host/port/auth from the live `@tikoci/quickchr`
  (0.4.5+, optional dependency) descriptor, bypassing CDB/env resolution for
  those fields.
- `--` — use it when the command contains tokens that would otherwise be
  claimed as centrs flags; otherwise the command must be quoted as a single
  argument. In fan-out, positional targets come BEFORE `--` and the command
  AFTER it (see **Target selection**). centrs flags go before `--` too: one of
  execute's own long flags after it (a trailing `--json`) is refused before
  dialing as `usage/flag-after-separator`, with the corrected line (#459).

### Designed, not implemented

Spec-tier flags with no implementation yet — today they fail as unknown flags:

| Flag                            | Designed behavior                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `--strict`                      | Treat any warning on a successful run as an error (`ok: false`, nonzero exit), like `-Werror`. Default is lenient (`ok: true` + `warnings`). |
| `--max-bytes <n>`               | Byte budget for the rendered envelope; excess output is truncated with a warning + `meta.truncated` (not an error), matching `retrieve`. (Will replace the implemented `--max-results`, which fails instead of truncating.) |

## SSH key selection

Signed off (settings names): SSH transports use one shared setting, `sshKey`,
exposed as `--ssh-key <path>`, `CENTRS_SSH_KEY`, and the CDB comment-kv token
`ssh-key=<path>`. Precedence follows the constitution: defaults → config → CDB
comment-kv → env → CLI/API. When unset, centrs honors the user's system SSH
configuration and agent exactly as `ssh` would; setting `--ssh-key` is an
explicit per-invocation override. The `ssh-key` setting (and `--insecure`) landed
with the first SSH consumer, `transfer`/sftp; `execute / ssh` (this command) and
`terminal / ssh` followed as separate transports over the same host-`ssh`
plumbing (`src/protocols/ssh.ts`) — all three SSH cells are `CHR-passed`.

A selected key adds `IdentitiesOnly=yes`, preventing fallback to unrelated
agent keys. Explicit OpenSSH `IdentityFile` configuration still applies; see
[`terminal` → SSH key selection](../terminal/README.md#ssh-key-selection).

Over SSH — like mac-telnet — `execute` is a **console transport**: it runs a
CLI line and returns text (`SshExecClient`, one `ssh user@host "<command>"` per
command; validation reuses the same `:put [:parse …]` gate), so structured
path-POST reads and `/console/inspect` are `rest-api`/`native-api`-only. Green via
`test/integration/execute-ssh.test.ts` (S1–S4); see `src/protocols/ssh.ts` for the
no-PTY/clean-output grounding.

`ssh-key` stores a private key **path**, never private key material. The resolved
path may appear in `meta.settings.sshKey` with its source so bug reports can
explain why a key was selected. Private key contents, passphrases, agent socket
contents, and any inline key material are always sensitive and must be listed in
`error.redactable_fields` if they appear in structured error data; key paths are
redacted only if the caller marks them sensitive or the error couples them with
key material.

## Target selection

`execute` runs the **same** RouterOS command across a multi-target selection over
the shared grammar (multiple `<target>` positionals, repeatable `--group`/
`--where`, the geo selectors `--near`/`--bbox`, `--all`, `--default`). The
grammar, the locked `FanoutData` envelope,
the record-order reassembly, and the granular **0/2/1 exit code** are normative in
[`docs/CONSTITUTION.md` → Target selection grammar](../../docs/CONSTITUTION.md#target-selection-grammar).

execute's positional **boundary is `--`** (it differs from `api`/`retrieve`,
whose last positional is the operation arg, because an execute command is itself
many tokens):

- `execute r1 r2 -- /system/reboot` — targets `[r1, r2]` before `--`, command
  after. **More than one positional target requires `--`.**
- `execute --group prod /system/resource/print` — selector-only: targets come
  from the selector and every positional is the command (no `--` needed).
- `execute r1 /system/resource/print` — a single positional target with no
  selector stays **single-target** (legacy split: first positional is the target,
  the rest is the command), never `FanoutData`.
- `execute --quickchr lab /system/resource/print` — the quickchr
  named-live-provider claims the target slots like a selector (positionals are
  the command; no `--` needed). One `--quickchr` stays single-target; repeating
  it fans out; mixing it with positionals or CDB selectors is
  `usage/conflicting-flags` (constitution: resolution providers).
- `execute --host http://192.0.2.10:8080 '/system/resource/print'` (or
  `execute --host <host|url> -- <command>`) — the `--host` **flag** stands in
  for a missing `<target>`: a lone positional is the command, and nothing
  before `--` is fine. There is no `<target>`, so there is no CDB lookup and no
  record credential can be picked up; auth comes from flags, env or config.
  Two or more positionals without `--` keep the legacy split, so
  `execute <mac> <command> --via mac-telnet --host <udp-host>` (the mac-telnet
  delivery override) is unchanged. `CENTRS_HOST` never changes positional
  parsing: `execute '<command>'` with it set still reads the lone positional as
  the target.

Because `execute` is the primary **write** path, a write-shaped fan-out is gated
by **`--yes`**, confirmed **once** up front; without it
the error names the blast radius (how many routers). Write-ness is determined from
the command alone (`canonicalizeExecuteCommand` + `isWriteShaped`), so the gate
fires before any target is dialed. Per-target validation still runs because
RouterOS schemas can differ by version.

A sent write is **never retried** (#448). Fan-out retries a target only for
`transport/network` and `transport/connection-closed`, and for a write only
when the failure came before the request was sent (for example while it was
being validated). A write that failed after it was sent may have run, so its
error envelope, single-target or fan-out, carries the warning
`transport/write-outcome-unknown`.

## CMR clients through their controller (`--cmr`)

`execute <controller> --cmr --labels <expr> -- '<command>'` runs one command on
the CMR clients (RouterOS 7.26beta1+) that a RouterOS label expression selects
on the controller (#450). The `<controller>` is an ordinary single target: a
positional or CDB identity, one `--quickchr`, or `--host`. It is resolved and
authenticated as usual, and **only the controller's credentials are used**. A
client is never dialed, so a client behind NAT or reachable only through its
controller works the same way. CMR is a selection source, not a protocol:
`--via` pins the **controller** transport (native-api, the default, or
rest-api). A CMR failure never falls back to dialing a client directly.

CMR is beta-only: it first shipped in 7.26beta1, and the controller also needs
the optional `cmr` package. When the target has no `/cmr/device`, centrs reads
its version to say why. A router older than 7.26beta1 is
`routeros/version-unsupported` (`capability: cmr-controller`). A newer one
without the package is `cmr/not-a-controller`, which also names the controller
when the target is itself a CMR client.

- `--labels` is required and passed to RouterOS unchanged: a comma list where
  plain labels are OR, `+label` must match, `-label` excludes, and `all` also
  selects the controller. CDB selectors (`--group`/`--where`/`--all`/
  `--default`/geo), several targets, and `--via mac-telnet|ssh` are
  `usage/conflicting-flags`. `--labels` without `--cmr` is refused the same way.
  Labels that no device has are accepted silently by RouterOS. An empty
  selection is `ok: true` with the warning `cmr/empty-selection` for a read,
  and the outer error `cmr/empty-selection` for a write-shaped command, with
  or without `--yes` (#460), as RouterOS refuses it (`no devices selected`). A
  mistyped label then exits 1 instead of looking like a successful bulk write.
  A device's
  identity selects it only while the controller's `/cmr auto-labels` includes
  `identity` (the default `all` does). On 7.26beta1, after `auto-labels=version`
  a client's row still *showed* its identity label but no longer matched it.
- **One `run-script` call per device.** On 7.26beta1, `run-script` result rows
  carry no device id, and their `device` key (`identity@address`) changed
  *during* a call when a client dropped. So centrs never matches rows to
  devices by name. Every controller call selects exactly one `/cmr/device` row
  with `numbers=<.id>`, together with `labels=<expr>`, so a device that left
  the labels is refused up front instead of run.
- **Preflight, per inventory row:** the call sends `:put [:parse <command>]`
  followed by `:put "<nonce>"`, or the nonce alone with `--no-validate`.
  - A refusal (`no devices selected`) means the device is not a member.
  - Any row means it is a member; its validation result must be **complete**
    before it is classified:
    - status `success`;
    - the nonce as the last line;
    - no `...(+N B)` clip marker;
    - a non-empty return that is IL.
  - A device with no answer at all (timeout, lost connection) makes the
    selection incomplete: `cmr/selection-incomplete`, and nothing runs. A
    partial selection is never run as if it were the whole one.
- **Binding:** `/cmr/device` is read before preflight, between preflight and
  the write gate, again for each member just before its own call (the prompt
  and the fan-out queue can both wait), and after dispatch. A device whose row
  is gone or whose `ids` key changed is not sent the command
  (`cmr/membership-changed`); a replacement row is never adopted, even when it
  matches the labels. If that per-member read fails, the member is not sent the
  command and its error says so (`context.dispatched: false`). The per-member
  read is host-side, not atomic with the call: on 7.26beta1 a client script
  cannot check its own key (`/cmr/client get local-id` reads `*****` inside
  `run-script`) and `numbers=` does not take `ids`. After dispatch, a sent result is reported
  as `cmr/outcome-unknown` if the key changed during the call, or if the
  inventory cannot be re-read (cancelled or unreadable) to confirm which client
  answered. A CMR `skipped` stays `cmr/client-disconnected`, because nothing was
  sent.
- **Write gate:** one `--yes`/TTY confirmation, naming how many clients will run
  it, how many were excluded, and through which controller. Clients that failed
  validation are never sent the command.
- **The controller login is not the limit (#456).** On 7.26beta1, RouterOS
  does not check the caller's policy against a CMR script. `run-script`
  needed only `read` + `api` on the controller login, and
  `/cmr/device/reboot` only `read` + `test` + `api`. A login refused a direct
  write (`not enough permissions (9)`) still wrote to clients and to the
  controller's own row through `run-script`, and rebooted a client through
  both. So a "reader" login on a 7.26beta1 controller is not read-only, and
  centrs' write gate (and `mcp=ro` on MCP) is the only gate. MikroTik
  [says](https://forum.mikrotik.com/t/7-26beta-development-is-released/273582/139) 7.26beta2 refuses this for a `read` group; that is not yet
  checked on a beta2 build. For a write,
  centrs reads the login's own `/user` row and `/user/group` once (both are
  readable with just `read` + `api`). When the login lacks `write`, `test` or
  `reboot`, the result and the confirmation error carry
  `cmr/caller-policy-not-enforced` naming what it lacks. A failed read only
  loses the warning.
- **Dispatch:** one call per validated member, sending the input unchanged with
  `timeout=` set from `--timeout` (capped at 55 s, under CMR's ~60 s per-call
  ceiling). Every call pins `strategy=parallel fail-policy=continue
  freeze-frame-interval=20ms`. **Never retried.**
- **Outcomes** are a `FanoutData` envelope in inventory order, with exit codes
  0/2/1. The outer `meta.target` is the controller, and the settings,
  request and login every member shares are written once on the outer
  envelope ([constitution](../../docs/CONSTITUTION.md#result-envelope)). Each
  member's `meta.target.cmr` carries `{id, deviceKey, address}`. `success` → `data.ret` holds the client's output; a clipped
  output adds `cmr/output-truncated` and `meta.truncated`. `--max-results`
  applies per member, as in plain execute fan-out: a member whose rendered
  envelope (with its full meta, as it would render alone) exceeds it (UTF-8 bytes) becomes `input/max-results-exceeded`, and
  that error says the command already ran (`context.dispatched: true`). A `failed` runtime
  error maps through the usual `routeros/*` table. `skipped` →
  `cmr/client-disconnected`.
- **What a client script may do:** CMR runs it with only the `read`, `write`,
  `test` and `reboot` policies and no user session. A command that needs
  another policy (`/user add`, `/tool sniffer`) passes `:parse` on the client
  and is refused when it runs: `cmr/policy-denied`. The script stops at that
  statement, but statements before it already ran and are not rolled back;
  their output is in `context.output`. Sensitive
  values read back as `*` or empty. Multi-line commands run every line (the
  manual says single-line; 7.26beta1 ran both LF and CRLF scripts in full), and
  `/export` works.
- **Unknown outcomes:** a CMR timeout (`timed out (6)`, `std failure: timeout
  (13)`), a local deadline, a cancellation, or a lost call after sending all
  give `cmr/outcome-unknown`. A cancellation before anything is sent, including
  one that makes an inventory read fail, is `cmr/cancelled`. On 7.26beta1 the client script **kept running**
  in each of these cases.
- **Validation metadata** reports what ran: `source: ":put [:parse ...] via cmr
  run-script"`, the same claim the console gate makes. There is no client
  `/console/inspect` stage.
- **No progress stream.** `run-script` returns a client's output only when its
  script ends, and no `/cmr` menu records a running script. To watch a long
  CMR job, follow what it changes on a client:
  `centrs retrieve <client> /ip/address --follow` while
  `execute <controller> --cmr` adds addresses. That only works when the client
  can also be reached directly; otherwise re-run a read through `--cmr`.
- **Not on MCP** until delegated authorization is designed (#449). That design
  must not assume RouterOS refuses a fleet write for a `!write` login (see
  above). `retrieve --cmr` is deferred (#441).

`/cmr/device/dashboard` is an interactive console view, refused as
`cmr/console-only`. A plain path, abbreviated or not (`/cmr/dev/dash`), is
refused before dialing. Any other spelling is found in the `:parse` return
during validation, which resolves console spacing, a relative menu change
(`/cmr/device; dashboard`), blocks and `api POST /execute` scripts, and ignores
strings and comments. With `--validate=false` only the plain path is refused.
On 7.26beta1 it closed a native API session, and over REST it held the
controller's REST service for every caller for 10–30 s.

Calling `/cmr/device/run-script` yourself, through `api` or plain `execute`,
validates only the controller request. The envelope then carries the warning
`cmr/client-script-not-validated`.

### Fleet commands run directly (#453)

A controller's fleet commands are one request to one router that act on many
devices: `/cmr/device/{reboot,upgrade,pair,run-script}`,
`/cmr/upgrade/trigger`, `/cmr/upgrade/job/run-next`, and `add`, `set`,
`remove`, `enable` or `disable` on `/cmr/vlan`, `/cmr/wifi`,
`/cmr/wifi/radio` and `/cmr/upgrade`. They are write-shaped, so they need
`--yes`. Before that gate, plain `execute` (and `api`) reads the controller's
`/cmr/device` inventory, read-only, and resolves which rows the command
reaches, where it can (see "Not resolved" below). The command still runs
exactly as typed.

- **The gate names the reach.** The prompt and the `usage/confirmation-required`
  summary say how many CMR devices the command reaches and whether the
  controller's own row (`controller=true`) is one of them. `error.context.cmr`
  has `devices`, `connected`, `controllerIncluded`, `identities` and
  `inventory`.
- **How the selection is resolved.** `numbers` matches a row's `.id` or
  identity. `labels` follows the manual's rules over the row's `labels` and
  `auto-labels`: plain labels are OR, `+label` must match, `-label` excludes,
  `all` selects every row, and an expression with only exclusions starts from
  every row. On a 7.26beta1 lab this matched the device's own selection
  (a `run-script` probe per row) for every expression tried; the lab test
  re-checks it (CMR-D9). It is the controller's current view: a disconnected
  device's `auto-labels` can be stale. `/cmr/upgrade/trigger` reaches the rows
  whose `upgrade-rule` it names. A rule's `set`, `remove`, `enable` or
  `disable` reads the rule's own `labels`; a `set` that changes `labels`
  reaches the old and the new devices. WiFi band labels (`+2ghz`, `+5ghz`,
  `+6ghz`) pick radios, not devices, so they are left out.
- **Warnings, with or without `--yes`:**
  - `cmr/selection-includes-controller`: the selection includes the
    controller's own row (`labels=all` does, per the manual).
  - `cmr/rule-selects-every-device`: a rule command with no device `labels`
    (for `/cmr/vlan`, no `port-labels` either). The manual warns that such a
    VLAN rule provisions every port of every connected device, the controller
    included, and cuts the fleet's management access.
  - `cmr/empty-selection`: by the controller's inventory now, nothing is
    selected. RouterOS refuses this for a `/cmr/device` command; it accepts
    a rule whose labels match nothing.
  - `cmr/caller-policy-not-enforced` for `run-script` and `reboot`, as for
    `--cmr` above (#456).
- **Not resolved:** an abbreviated selector argument (`lab=all`),
  `--via ssh` or `mac-telnet`, `/cmr/upgrade/job/run-next` (a job's devices
  are not in the inventory), and a failed read. The gate still names the
  fleet command and says why its reach is unknown, for example `would reach
  the CMR devices it selects through controller ctl (not resolved: an upgrade
  job's devices are not in the inventory)`, and `error.context.cmr` has
  `unresolved` instead of the counts. A failed read never blocks the command,
  and after a transport or login failure the policy read is skipped. Two
  cases are not recognized as fleet commands at all and keep the plain
  wording: script-shaped input (a positional id or `[find …]`) and CDB fan-out
  to several controllers, which has its own gate.

## mac-telnet L2 validation

Decided (2026-06-06): the real-L2 integration path is `@tikoci/quickchr`'s
host-side L2 capture. The host runs a TCP server and the CHR gets a
`socket-connect` NIC; QEMU streams every guest Ethernet frame to the host
length-prefixed (4-byte BE length + raw frame), and **a frame written back is
injected into the guest — exactly the MAC-Telnet primitive**. Loopback-only,
cross-platform, no root and no native raw-L2 helper; REST/native-API keep a
separate user-mode NIC with hostfwd. Prefer `socket-connect` over `socket-mcast`
(the multicast netdev is broken on macOS — QEMU sets only `SO_REUSEADDR` where
macOS needs `SO_REUSEPORT`; mcast works on Linux/CI). Grounding: quickchr
`docs/mndp.md`, `examples/mndp/`, `test/lab/mndp/REPORT.md`.

`execute / mac-telnet` is now **`CHR-passed`** end to end over real L2 against
stock CHR 7.23.1 (`test/integration/mac-telnet-console.test.ts` +
`mactelnet-l2-bridge.ts`, examples 20–22): `executeEnvelope` resolves a MAC
target, the `MacTelnetAdapter` opens a `MacTelnetConsole` over a UDP datagram
transport, and reads, writes (REST-verified), and validation-rejects all work.

How it is wired:

- **Console transport, not request/response.** mac-telnet drives the RouterOS
  interactive console (`src/protocols/mac-telnet-console.ts`): it answers the
  login terminal-size probe, auto-clears the first-login license, syncs on the
  `[user@identity] >` prompt, emulates the CR/LF screen, and strips the echoed
  command + trailing prompt to return clean per-command output. The orchestrator
  runs the **raw CLI line** over the console (no structured path-POST / tagged
  talk); the `MacTelnetAdapter` reports `retrieve`/`inspect` as
  `transport/capability-unsupported` (mac-telnet is execute/terminal only).
- **Validation is one console `:parse`.** Over the console, `:put [:parse "<cmd>"]`
  prints both `syntax error` and `bad parameter <name>`, so a single gate covers
  syntax **and** the unknown-attribute (name-level) check — no `/console/inspect`
  table parsing. Maps to `validation/syntax` / `validation/unknown-attribute`,
  same codes as REST/native (see `docs/CONSTITUTION.md`, validation).
- **Auth (grounded):** MTWEI is required; a stock device offers a 16-byte MD5 salt
  but rejects the MD5 proof, so centrs advertises MTWEI (`src/protocols/mtwei.ts`)
  by default. `END_AUTH` ≠ success (a failed login emits `END_AUTH` then "Login
  failed" + `END`) → `transport/auth-failed`.
- **Console quirks to know:** a successful write **prints no output** (no `.id`,
  unlike REST/native — `data.ret` is empty on a successful add); and there is a
  ~10s terminal-negotiation stall on every login (a latency cost, not a
  correctness issue — see `commands/terminal/README.md` for the optional fix).
- **Delivery:** the UDP transport sends to `--host`/`--port` (default L2 broadcast
  `255.255.255.255:20561`); the device replies to our source IP:port, and the
  in-packet MACs do the addressing. The CHR test points `--host`/`--port` at the
  loopback L2 bridge.

Protocol selection: an unresolved MAC target auto-selects mac-telnet (covered by
`test/unit/execute.test.ts`); callers wanting IP-level execution opt into ARP
(`--resolve arp` + `--via native-api`/`rest-api`).

## Open shape questions

- ~~How to expose multi-line / async / progress output~~ — **resolved:**
  open-ended follow/streaming reads are `api … --stream` (NDJSON stream of
  envelopes; see `commands/api/README.md`). `execute` stays single-shot
  read/write; it does not grow a follow mode.
- ~~Whether `--strict` should reject "succeeded with stderr-like content."~~ —
  **decided:** `--strict` promotes any warning on an otherwise-successful run to
  `ok: false` (nonzero exit), like `-Werror`; the default stays lenient
  (`ok: true` with the warning in the `warnings` channel). Tracked code
  follow-up; the flag is under **Designed, not implemented** above.

These are deferred refinements to the already-grounded single-shot envelope,
not blockers for the `rest-api`/`native-api` cells.
