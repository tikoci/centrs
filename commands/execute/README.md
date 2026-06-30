# execute

Run a RouterOS CLI command and return its (semi-structured) output. `execute`
is the single read/write surface for RouterOS add/set/remove and other
CLI-shaped commands — there is no separate `update` command.

Status: `rest-api`, `native-api`, `mac-telnet`, and `ssh` are `CHR-passed` (see
`docs/MATRIX.md` and `commands/execute/examples.md`, examples 1–11 over REST,
12–18 over the native API, 19–21 over mac-telnet, and S1–S4 over ssh, green via
`bun run test:integration`). `romon` and `winbox-terminal` remain
`not-started`. SNMP is retrieve-only and rejects `execute`.

## Intent

- Mirror RouterOS `execute` semantics. Input is a CLI string; output is
  console-shaped text (or structured records for path+verb writes) wrapped in
  the standard envelope. This includes write-shaped add/set/remove.
- Validation is two-stage (see constitution: validation): `:put [:parse
  "<cmd>"]` is a **syntax** gate only — it does not catch unknown attributes or
  bad values. Semantic validation needs `/console/inspect` or the server's own
  re-validation on the write round-trip. A clean parse is necessary, not
  sufficient.
- centrs owns the **script-vs-structured gate** (`canonicalizeExecuteCommand` +
  `isWriteShaped` in `src/execute.ts`): it decides which validation runs and
  whether the write-confirm prompt fires. The shared `rosetta`/`lsp-routeros-ts`
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
- **Run-time fault mapping — later (JG-28).** `mapRouterOsError`'s table covers
  the faults seen so far; a known gap is errors that *pass* `:parse`/validation
  but fail at **run time** (a syntactically valid command the router rejects when
  executed). `tikoci/vscode-tikbook` has an error-string mapping for these worth
  porting into `src/core/routeros-errors.ts`. Background research, not yet
  scheduled — captured here so it isn't lost (no GitHub issue by design).
- Output is *string*-shaped for script-mode; richer parsing is a future
  concern. The envelope must still distinguish RouterOS errors from successful
  runs (a 200 with a RouterOS error string is still an error — see
  constitution: error model).
- **Print width / column wrapping (JG-04).** RouterOS wraps `print` output to the
  terminal width, so each transport handles width differently. **mac-telnet** is
  the only one that negotiates a size: `src/protocols/mac-telnet-console.ts`
  answers the device's terminal-size probe with a deliberately tall/wide screen,
  so captured columns are neither wrapped nor paginated. **SSH execute** runs
  *without* a pseudo-tty (`src/protocols/ssh.ts`), so RouterOS emits no
  terminal-wrapped output to begin with — there is nothing to negotiate.
  **REST/native-api** are not consoles, so terminal width never applies (they
  return structured records, or a string `ret` for script-mode). There is
  therefore no per-call `--width` knob today — an explicit width override is
  deferred until a concrete need appears.
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
- When the resolved transport is mac-telnet and **no** username or password is
  resolved from any source, execute emits a `tip/mac-telnet-no-credentials`
  pointer: mac-telnet logs in with RouterOS credentials over **MTWEI** (MD5 is
  refused by current RouterOS), so an empty login is rejected at connect time.
  It is a tip, not an error — the call is still attempted.
- Default output is human-readable `text`; pass `--json`/`--format json`
  (or set `CENTRS_FORMAT=json`) for the structured envelope. Errors always
  render as `[code] summary` + `Fix:` lines in text mode.
- CDB comment-kv metadata may provide per-target `via`, `port`, and `ssh-key`
  overrides; CLI/API arguments still win.
- RoMON and WinBox Terminal are lower priority than mac-telnet until their
  validation, tooling, and CI story are grounded.

## Flags

| Flag                            | Behavior                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `--via <protocol>`              | Pin the transport (`native-api`, `rest-api`, `ssh`, or `mac-telnet`). No silent downgrade. A bare MAC target defaults to `mac-telnet`. |
| `--host <host\|url>`            | Override the resolved host or base URL for the target.                                 |
| `--port <n>`                    | Override the resolved management port.                                                 |
| `--username` (alias `--user`, `-u`) / `--password` | RouterOS credentials; fall back to `CENTRS_USERNAME` / `CENTRS_PASSWORD`.              |
| `--ssh-key <path>`              | `--via ssh`: explicit private-key path. Falls back to `CENTRS_SSH_KEY` / the ssh-agent. |
| `--insecure`                    | Accept a new SSH host key (`--via ssh`) or a self-signed `api-ssl` TLS cert. Default verifies. |
| `--cdb-file` / `--cdb-password` | Read target credentials from (and decrypt) a WinBox CDB file.                          |
| `--resolve <none\|arp>`         | Resolve a MAC-address target to an IP via the host ARP cache. Default `none`.          |
| `--timeout <duration>`          | Per-request timeout. REST: ≤ 60s; other transports may allow longer.                  |
| `--validate[=false]`            | Run transport-appropriate preflight validation before execution (default `true`): REST/native use `:parse` + `/console/inspect`; mac-telnet and ssh use a single console `:parse` (covers syntax + unknown-attribute). |
| `--strict`                      | Treat any warning on a successful run as an error (`ok: false`, nonzero exit), like `-Werror`. Default is lenient (`ok: true` + `warnings`). |
| `--yes`                         | Confirm write-shaped add/set/remove commands in non-interactive runs.                  |
| `--max-bytes <n>`               | Byte budget for the rendered envelope; excess output is truncated with a warning + `meta.truncated` (not an error), matching `retrieve`. (Renamed from `--max-results`.) |
| `--format <text\|json\|yaml>`   | Output format (alias `--json`). Defaults to `text`; `CENTRS_FORMAT` sets the default.  |
| `--where <attr>=<value>`        | Device-class selector — run across every CDB record whose stored fact/comment-kv matches (e.g. `--where board=RB5009 /system/package/check-for-updates`). Repeatable (AND). See constitution: target selection. |
| `--`                            | End-of-options marker. Every token after `--` is taken as the literal RouterOS command, even flag-shaped ones — e.g. `centrs execute $R -- /interface print where disabled=yes`. Use it when the command contains tokens that would otherwise be claimed as centrs flags; otherwise the command must be quoted as a single argument. |

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
`mactelnet-l2-bridge.ts`, examples 19–21): `executeEnvelope` resolves a MAC
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
  syntax **and** the unknown-attribute (semantic) check — no `/console/inspect`
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
  follow-up; the flag is in the table above.

These are deferred refinements to the already-grounded single-shot envelope,
not blockers for the `rest-api`/`native-api` cells.
