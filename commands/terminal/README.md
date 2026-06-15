# terminal

Open an interactive RouterOS console.

Status: `terminal / mac-telnet` **and** `terminal / ssh` are both **`CHR-passed`**
(see `docs/MATRIX.md` and `examples.md` T1–T3 / TS1–TS2). The two transports take
different paths: **mac-telnet** is the in-process raw passthrough over
`MacTelnetConsole.attachInteractive`; **ssh** execs the host `ssh` with inherited
stdio (RouterOS grants no PTY, but `ssh user@host` opens the console and the OS
relays the already-clean stream — no screen emulation; a host target defaults to
ssh, a MAC target to mac-telnet). The mac-telnet path is described below;
`src/terminal.ts` is the raw passthrough over `MacTelnetConsole.attachInteractive`,
driven through an injectable `TerminalIo` (real stdin/stdout/`SIGWINCH` in
`src/cli/terminal.ts`). Two input modes by whether stdin is a TTY: interactive
(raw-mode keystrokes, real size) and batch (pipe a command, close on EOF after an
output drain). The pipe integration test does not exercise raw-mode/real-TTY-size
(a piped subprocess stdin is not a TTY); a full-TTY test would need a PTY and is
deferred.

`terminal` is also the documentation home for SSH as a centrs transport. **Re-scoped
(decided with the user): SSH lands transfer-first, not as one monolithic unit.**
The SSH transport *base* shipped as the **SFTP transfer client** (`transfer / ssh`,
`src/protocols/sftp.ts` over the host OpenSSH `sftp` subsystem); the `ssh-key` and
`insecure` settings landed **with** it (so no setting is half-wired without a
working transport — the rule still holds). `execute / ssh` and `terminal / ssh`
then followed and are both `CHR-passed`. **A CHR spike corrected the earlier "no
exec channel, needs an interactive-shell reader" framing:** RouterOS's SSH server
has **no pseudo-tty**, but a single-line `ssh user@host "<command>"` runs on the
console and returns clean output — so `execute / ssh` is a per-command batch client
and `terminal / ssh` is a thin inherited-stdio exec of `ssh`. Neither needed a
`MacTelnetConsole`-style screen-emulating reader. The one no-PTY limitation is the
device's, not centrs's: multi-line brace blocks (`{ … }`) do not work over
`terminal / ssh` — reach for `mac-telnet` when you need them.

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

Unlike the batch sftp/execute clients, the **interactive** `terminal / ssh` argv
omits `BatchMode=yes` (`interactive: true` in `sshCommonOptions`), so the host
`ssh` can prompt on the inherited TTY for an encrypted key's passphrase or a
password. centrs does not forward `--password` to ssh — OpenSSH accepts no
password on the argv — so password auth is satisfied by that interactive prompt,
not by the centrs-resolved credential.

Resolved by the sftp transfer client (`src/protocols/sftp.ts`), so they are no
longer open for the file path: **host-key verification** rides the unified
`--insecure` knob (default `StrictHostKeyChecking=accept-new` trust-on-first-use;
a changed key → `transport/host-key-mismatch`; `--insecure` →
`StrictHostKeyChecking=no` — see `docs/CONSTITUTION.md`, Transport trust);
**agent vs explicit-key** interplay and **algorithm negotiation** are delegated to
the host OpenSSH (`-i <ssh-key>` when set, else the agent / `~/.ssh/config`).
Still open for the **interactive** surfaces: the `terminal`→`mac-telnet` fallback
when SSH is unreachable but a MAC is on file, and the no-pseudo-tty console reader.

The setting stores a key path only. Private key material, passphrases, and agent
contents are always sensitive and belong in `error.redactable_fields` if an
error carries them; the selected key path may appear in `meta.settings.sshKey`
with its source unless the caller marks paths sensitive.

## RouterOS SSH surface (device-side option alignment)

What RouterOS's SSH server exposes (`/ip/ssh`, grounded on the
[SSH](https://help.mikrotik.com/docs/spaces/ROS/pages/132350014/SSH) and
[User](https://help.mikrotik.com/docs/spaces/ROS/pages/8978504/User) pages,
RouterOS 7.x) and how the centrs client (host OpenSSH) lines up — so there are no
gaps between what the device offers and what centrs can negotiate:

| RouterOS `/ip/ssh` | Values (default) | How centrs aligns |
| ------------------ | ---------------- | ----------------- |
| `host-key-type` | `ed25519` \| `rsa` (**rsa**) | Host OpenSSH accepts both; the default device host key is RSA, so the client must offer `rsa-sha2-256/512` and `ssh-ed25519`. TOFU pins whichever the device presents. |
| `strong-crypto` | `yes` \| `no` (**no**) | `yes` disables ssh-rsa/SHA1, null ciphers, and MD5, and uses sha256 MACs + a 2048-bit DH prime. OpenSSH already prefers `rsa-sha2-*` / curve25519, so a strong-crypto device negotiates cleanly with no client change. |
| `ciphers` | `3des-cbc`\|`aes-cbc`\|`aes-ctr`\|`aes-gcm`\|`auto`\|`null` (**auto**) | Per-cipher control added ~7.17. OpenSSH's default cipher set covers `aes-ctr`/`aes-gcm`; `null` (no encryption) is never offered by the client. |
| `password-authentication` | `yes-if-no-key` \| `yes` \| `no` (**yes-if-no-key**) | The default refuses password login once a user has an imported SSH key, so centrs's normal path is key auth (`--ssh-key` / agent). No password is ever placed on the `sftp` argv. |
| `publickey-authentication-options` | `none`\|`touch-required`\|`verify-required` (**none**) | FIDO touch/verify is handled by the host ssh-agent when the key is a FIDO key; transparent to centrs. |
| `forwarding-enabled` | `both`\|`local`\|`remote`\|`no` (**no**) | centrs does not use SSH forwarding; no dependency. |
| — (subsystem) | SFTP subsystem | The reliable **file** channel (no pseudo-tty; a single-line `ssh host "cmd"` exec runs, but it's for `execute`, not files); `transfer --via sftp` speaks it. scp would ride the same subsystem on modern OpenSSH. **CHR-confirmed (7.23.1):** `put`/`get`/`ls`/`mkdir`/`rm` all work over the subsystem. |
| `/user` group policy | `ftp` (+ `ssh`, `read`/`write`) | SFTP file access needs the user group's `ftp` policy. **CHR-confirmed:** the `full`-group admin (which includes `ftp`) authenticates and transfers; a restricted user must be granted `ftp`. |

**CHR finding (7.23.1):** RouterOS's sftp `ls -l` does **not** report a reliable
byte size (the long-name size column is unpopulated / server-format-specific). So
centrs's sftp client treats `ls` as an existence + name probe only, and
`transfer --verify size` over sftp trusts the **SFTP transfer guarantee** (a
partial `put`/`get` errors) rather than re-reading a size. REST/native keep their
JSON `/file` size cross-check. See `src/protocols/sftp.ts` (`parseLsOutput`) and
`src/transfer.ts` (`SftpFileBackend.findFile`).

These are device facts the host OpenSSH negotiates for us; the alignment table is
the audit trail that the centrs file path has no hole versus what RouterOS offers.

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
