# terminal

Open an interactive RouterOS console.

Status: `not-started`. This file is a stub.

`terminal` is the **introduction point for SSH** as a centrs transport. SSH
lands as one complete transport — `terminal/ssh`, `execute/ssh`, and the
`scp`/`sftp` transfer path — not piecemeal: a half-wired SSH (e.g. the `ssh-key`
comment-kv key without a working transport) is worse than none, because it
misleads agents working on adjacent cells. The `ssh-key` setting therefore joins
the comment-kv allowlist *with* the SSH transport, not before it.

## Intent

- `ssh` is the default. It honors system `ssh` config and the user's SSH agent;
  `--ssh-key` overrides with an explicit private key path. CDB metadata may carry
  the path to a per-router private key.
- `mac-telnet` is the right transport when `<router>` is a MAC address, or
  when SSH is unreachable but a MAC is on file (Layer-2 emergency access).
- REST and native API have no terminal capability; `--via rest-api` for
  `terminal` must error with `transport/capability-unsupported`.
- RoMON and WinBox Terminal are execute protocol surfaces in centrs, not
  terminal routes, unless future matrix cells explicitly add terminal support.

## SSH key selection

Signed off (settings names): terminal uses the same `sshKey` setting as
`execute`: `--ssh-key <path>`, `CENTRS_SSH_KEY`, and CDB comment-kv
`ssh-key=<path>`. Precedence is defaults → config → CDB comment-kv → env →
CLI/API. When no key is set, terminal delegates identity selection to system
`ssh` config and the SSH agent; `--ssh-key` is an explicit override and must not
silently merge with a conflicting CDB/env key.

Residual unknowns to resolve *during* the atomic SSH implementation (not
blockers for these names): host-key verification / `known_hosts` policy, agent
vs explicit-key interplay, RouterOS algorithm negotiation, and the
`terminal`→`mac-telnet` fallback when SSH is unreachable but a MAC is on file.

The setting stores a key path only. Private key material, passphrases, and agent
contents are always sensitive and belong in `error.redactable_fields` if an
error carries them; the selected key path may appear in `meta.settings.sshKey`
with its source unless the caller marks paths sensitive.

## mac-telnet L2 validation

Decided (2026-06-06): terminal/mac-telnet uses the same `@tikoci/quickchr`
host-side L2 capture path as execute/mac-telnet — a host TCP server with the CHR
on a `socket-connect` NIC (QEMU streams guest frames length-prefixed; a frame
written back injects L2). Loopback-only, cross-platform, no root. Prefer
`socket-connect` over `socket-mcast` (macOS-broken — `SO_REUSEPORT`). That
harness is now wired and the **transport base is proven over real L2 against
stock CHR 7.23** (`test/integration/mac-telnet.test.ts`): the MTWEI (EC-SRP)
login completes, the console session opens, and data flows both ways. See
`commands/execute/README.md` (mac-telnet L2 validation) for the auth findings
(MTWEI required, MD5 refused, `END_AUTH` ≠ success).

The unresolved-MAC default remains load-bearing: a MAC target chooses
mac-telnet for terminal unless an IP-level resolution path is explicitly
requested. Covered with resolver/selection tests plus packet/session coverage in
`test/unit/mac-telnet.test.ts` and EC-SRP coverage in `test/unit/mtwei.test.ts`.

## Interactive-console work (advances terminal/mac-telnet to CHR-passed)

The protocol is proven; the interactive *console* is the remaining
terminal-layer work. On login the RouterOS console emits a
terminal-identification query (e.g. `ESC Z`) and renders a readline prompt with
keystroke echo, so a usable `terminal` must answer terminal queries, track the
prompt, and surface clean I/O. Two protocol facts to honor:

- **MTWEI does not encrypt the terminal stream** — treat it as management-plane
  traffic on a trusted L2 segment.
- **Idle keepalive:** the reference client sends an empty ACK after ~10s idle and
  the server times out a session after ~15s of silence, so an interactive
  session needs a keepalive timer (`MacTelnetSession` is currently reactive only,
  with no retransmit/keepalive timer — fine for a quick exchange, needed for a
  held-open terminal).

## Open questions

- How to surface keystroke recording / replay for tests.

Defer the interactive console until terminal/ssh or execute/mac-telnet wiring
begins; the transport, auth, and data path are already grounded.
