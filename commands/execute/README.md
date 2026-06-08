# execute

Run a RouterOS CLI command and return its (semi-structured) output. `execute`
is the single read/write surface for RouterOS add/set/remove and other
CLI-shaped commands — there is no separate `update` command.

Status: `rest-api` and `native-api` are `CHR-passed` (see `docs/MATRIX.md` and
`commands/execute/examples.md`, examples 1–11 over REST and 12–18 over the
native API, green via `bun run test:integration`). `ssh`, `mac-telnet`,
`romon`, and `winbox-terminal` remain `not-started`. SNMP is retrieve-only and
rejects `execute`.

## Intent

- Mirror RouterOS `execute` semantics. Input is a CLI string; output is
  console-shaped text (or structured records for path+verb writes) wrapped in
  the standard envelope. This includes write-shaped add/set/remove.
- Validation is two-stage (see constitution: validation): `:put [:parse
  "<cmd>"]` is a **syntax** gate only — it does not catch unknown attributes or
  bad values. Semantic validation needs `/console/inspect` or the server's own
  re-validation on the write round-trip. A clean parse is necessary, not
  sufficient.
- REST adapter prefers structured path-POST when the CLI canonicalizes to
  path+verb+attrs (`POST /rest/<path>/<verb>` → `{"ret":"<.id>"}`, clean typed
  errors); falls back to `POST /rest/execute {"script":"<cli>"}` for
  non-path-shaped console commands.
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
- Output is *string*-shaped for script-mode; richer parsing is a future
  concern. The envelope must still distinguish RouterOS errors from successful
  runs (a 200 with a RouterOS error string is still an error — see
  constitution: error model).
- Attribute values pass through **verbatim** — centrs does not guess types or
  coerce them (RouterOS REST tolerates string values; the native API is
  all-strings). Unlike `jo`-style KV builders, there is no per-value
  type-forcing escape, because the device, not centrs, owns value typing.
- On an empty-CDB resolution failure, execute (like retrieve) emits the
  `tip/no-devices` tip, steering toward `centrs devices discover` /
  `centrs config`.
- Protocol surfaces are native API, REST, mac-telnet, and SSH. RoMON and
  WinBox Terminal are later. SNMP is retrieve-only and must reject execute.
- For a MAC target not resolved from CDB, auto-selection defaults to
  mac-telnet. Callers that want IP-level execution may opt into ARP-based
  MAC → IP resolution with `--resolve arp` (plus `--via native-api`/`rest-api`)
  before protocol selection.
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
| `--via <protocol>`              | Pin the transport (`native-api` or `rest-api`). No silent downgrade.                   |
| `--host <host\|url>`            | Override the resolved host or base URL for the target.                                 |
| `--port <n>`                    | Override the resolved management port.                                                 |
| `--username` / `--password`     | RouterOS credentials; fall back to `CENTRS_USERNAME` / `CENTRS_PASSWORD`.              |
| `--cdb-file` / `--cdb-password` | Read target credentials from (and decrypt) a WinBox CDB file.                          |
| `--resolve <none\|arp>`         | Resolve a MAC-address target to an IP via the host ARP cache. Default `none`.          |
| `--timeout <duration>`          | Per-request timeout. REST: ≤ 60s; other transports may allow longer.                  |
| `--validate[=false]`            | Run the `:parse` + `/console/inspect` gate before execution (default `true`).          |
| `--strict`                      | Treat any warning on a successful run as an error (`ok: false`, nonzero exit), like `-Werror`. Default is lenient (`ok: true` + `warnings`). |
| `--yes`                         | Confirm write-shaped add/set/remove commands in non-interactive runs.                  |
| `--max-bytes <n>`               | Byte budget for the rendered envelope; excess output is truncated with a warning + `meta.truncated` (not an error), matching `retrieve`. (Renamed from `--max-results`.) |
| `--format <text\|json\|yaml>`   | Output format (alias `--json`). Defaults to `text`; `CENTRS_FORMAT` sets the default.  |
| `--where <attr>=<value>`        | Device-class selector — run across every CDB record whose stored fact/comment-kv matches (e.g. `--where board=RB5009 /system/package/check-for-updates`). Repeatable (AND). See constitution: target selection. |

## SSH key selection

Signed off (settings names): SSH transports use one shared setting, `sshKey`,
exposed as `--ssh-key <path>`, `CENTRS_SSH_KEY`, and the CDB comment-kv token
`ssh-key=<path>`. Precedence follows the constitution: defaults → config → CDB
comment-kv → env → CLI/API. When unset, centrs honors the user's system SSH
configuration and agent exactly as `ssh` would; setting `--ssh-key` is an
explicit per-invocation override. SSH lands as one complete transport
(introduced via `terminal/ssh`; see `commands/terminal/README.md`), so
`execute/ssh` and the `ssh-key` comment-kv allowlist entry arrive together, not
piecemeal.

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

That harness is now wired (`test/integration/mac-telnet.test.ts` +
`mactelnet-l2-bridge.ts`) and the **transport base is proven over real L2
against stock CHR 7.23**. Findings that shape the command wiring:

- **MTWEI is required; classic MD5 is dead on current RouterOS.** A stock 7.23
  device offers a 16-byte MD5 salt to a classic client but **rejects the MD5
  proof for credentials it accepts over REST/native-API**. centrs therefore
  advertises MTWEI (EC-SRP, `src/protocols/mtwei.ts`) by default and computes the
  32-byte proof from the 49-byte salt; MD5 remains only as a fallback for legacy
  gear that still honors it. The MTWEI login completes end to end on real CHR.
- **`END_AUTH` ≠ success.** A failed login also emits `END_AUTH`, then a
  "Login failed" message and `END`. centrs confirms success only when real
  terminal output arrives, and maps the failure to `transport/auth-failed`.
- **Interactive console handling is the remaining command-layer work.** After
  login the RouterOS console sends a terminal-identification query and renders a
  readline prompt, so capturing clean `execute` output over mac-telnet needs
  terminal-query handling + echo/prompt parsing. The transport/auth/data path is
  validated; this glue is what advances `execute / mac-telnet` toward
  `CHR-passed`.

The executable contract still must cover protocol-selection behavior: when the
`execute` target is an unresolved MAC address, auto-selection chooses
mac-telnet; callers that want IP-level execution must explicitly opt into ARP
resolution before protocol selection. That behavior is covered with
resolver/protocol-selection tests plus `test/unit/mac-telnet.test.ts` /
`test/unit/mtwei.test.ts`; the `execute / mac-telnet` matrix cell advances to
`CHR-passed` once the command wiring + console handling land.

## Open shape questions

- ~~How to expose multi-line / async / progress output~~ — **resolved:**
  open-ended follow/streaming reads are the separate read-only `stream` verb
  (NDJSON stream of envelopes; see `commands/stream/README.md`). `execute` stays
  single-shot read/write; it does not grow a follow mode.
- ~~Whether `--strict` should reject "succeeded with stderr-like content."~~ —
  **decided:** `--strict` promotes any warning on an otherwise-successful run to
  `ok: false` (nonzero exit), like `-Werror`; the default stays lenient
  (`ok: true` with the warning in the `warnings` channel). Tracked code
  follow-up; the flag is in the table above.

These are deferred refinements to the already-grounded single-shot envelope,
not blockers for the `rest-api`/`native-api` cells.
