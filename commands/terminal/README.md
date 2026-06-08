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
harness is wired and `execute / mac-telnet` is **`CHR-passed`** over it
(`test/integration/mac-telnet-console.test.ts`): MTWEI login, the console reader,
clean command output, writes, and the `:parse` validation gate all work end to
end. The bridge also relays UDP both ways (`udpPort`), so the production UDP
transport is exercised, not just the in-process callbacks. See
`commands/execute/README.md` (mac-telnet L2 validation) for the console wiring and
auth findings (MTWEI required, MD5 refused, `END_AUTH` ≠ success).

The unresolved-MAC default remains load-bearing: a MAC target chooses
mac-telnet for terminal unless an IP-level resolution path is explicitly
requested. Covered with resolver/selection tests plus packet/session coverage in
`test/unit/mac-telnet.test.ts` and EC-SRP coverage in `test/unit/mtwei.test.ts`.

## Interactive-console work (advances terminal/mac-telnet to CHR-passed)

The console reader landed with `execute / mac-telnet` (`CHR-passed`): it answers
the login terminal-size probe, auto-clears the first-login license, syncs on the
prompt, and emulates the CR/LF screen — grounded on CHR 7.23.1 (the login probe
is actually a multi-step ANSI cursor probe; `ESC[6n` DSR is the operative query,
answered with `ESC[rows;colsR`). `terminal / mac-telnet` reuses that reader; what
it adds on top is **interactive relay**, not protocol work:

- **PTY relay**: wire local stdin → `session.sendInput` and console output →
  stdout in raw mode, instead of the `run(cli)` capture path `execute` uses.
- **Real terminal size**: report the actual PTY rows/cols to the probe (and on
  `SIGWINCH`), where `execute` reports an oversized screen to avoid paging/wrap.
- **Idle keepalive + retransmit (already landed):** `MacTelnetSession.tick(now)`
  (driven by `MacTelnetConsole` on a ~200ms interval) sends an empty-ACK keepalive
  after ~8s idle and retransmits the last unacked frame on the reference backoff
  schedule. So a held-open `terminal` is already kept alive; the relay just needs
  to keep `tick` running (it does, via the console reader).
- **~10s prime stall (optional polish):** every mac-telnet login waits ~10s for
  terminal negotiation before the prompt; answering the DSR sets the width but
  does not remove the stall. A cursor-tracking emulator (track row/col, answer
  each `ESC[6n` with the real clamped position) would likely kill it. Latency
  only — not a blocker.

Protocol facts to honor: **MTWEI does not encrypt the terminal stream** — treat
it as management-plane traffic on a trusted L2 segment.

## Open questions

- How to surface keystroke recording / replay for tests.

The transport, auth, console reader, and data path are all grounded; only the
interactive-relay layer above remains for terminal/mac-telnet.
