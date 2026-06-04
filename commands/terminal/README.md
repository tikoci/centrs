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

Proposed pending sign-off: terminal/mac-telnet remains protocol-layer validated
until centrs has a maintained raw-L2 helper. `@tikoci/quickchr` can run CHR with
L2-capable QEMU netdevs, but the current integration entry point uses user-mode
SLIRP and Bun cannot open BPF/AF_PACKET frames directly. Do not mark the cell
`CHR-passed` until a real L2 segment and host frame I/O are available.

The unresolved-MAC default remains load-bearing for tests: a MAC target chooses
mac-telnet for terminal unless an IP-level resolution path is explicitly
requested. Until real L2 exists, cover that default with resolver/selection tests
and keep packet/session coverage in `test/unit/mac-telnet.test.ts`.

## Open questions

- How to surface keystroke recording / replay for tests.

Defer until at least one transport beyond REST is implemented.
