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

## SSH key selection

Proposed pending sign-off: SSH transports use one shared setting, `sshKey`,
exposed as `--ssh-key <path>`, `CENTRS_SSH_KEY`, and the CDB comment-kv token
`ssh-key=<path>`. Precedence follows the constitution: defaults → config → CDB
comment-kv → env → CLI/API. When unset, centrs honors the user's system SSH
configuration and agent exactly as `ssh` would; setting `--ssh-key` is an
explicit per-invocation override.

`ssh-key` stores a private key **path**, never private key material. The resolved
path may appear in `meta.settings.sshKey` with its source so bug reports can
explain why a key was selected. Private key contents, passphrases, agent socket
contents, and any inline key material are always sensitive and must be listed in
`error.redactable_fields` if they appear in structured error data; key paths are
redacted only if the caller marks them sensitive or the error couples them with
key material.

## mac-telnet L2 validation

Proposed pending sign-off: keep mac-telnet validated at the protocol layer for
now and explicitly defer real-router L2 validation until a maintained raw-L2
helper exists. The current `@tikoci/quickchr` integration harness uses QEMU
user-mode SLIRP, which does not carry Ethernet broadcasts or MAC-Telnet frames;
Bun also exposes no BPF/AF_PACKET raw-L2 socket. A libpcap/socket_vmnet shim may
become the long-term harness, but it should not block execute design or force
fragile CI privileges today.

The executable contract still must cover protocol-selection behavior: when the
`execute` target is an unresolved MAC address, auto-selection chooses
mac-telnet; callers that want IP-level execution must explicitly opt into ARP
resolution before protocol selection. Until the L2 harness exists, that behavior
is covered with resolver/protocol-selection tests plus
`test/unit/mac-telnet.test.ts` against a scripted peer, not by advancing the
matrix cell to `CHR-passed`.

## Open shape questions

- How to expose multi-line / async / progress output without committing to a
  single-shot model up front.
- Whether `--strict` should reject "succeeded with stderr-like content."

These are deferred refinements to the already-grounded single-shot envelope,
not blockers for the `rest-api`/`native-api` cells.
