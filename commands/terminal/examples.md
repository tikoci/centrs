# terminal — examples

Each numbered example is an executable spec. The integration test under
`test/integration/terminal-mac-telnet.test.ts` runs the CHR-testable examples
(T1–T3) against a CHR booted by `@tikoci/quickchr` over a real L2 path, driving
the **real `centrs terminal` binary** through the subprocess harness
(`test/integration/cli-process.ts`) pointed at the L2 bridge's UDP relay — the
same transport the `execute / mac-telnet` command path uses.

`terminal` is a **raw passthrough**, not an enveloped command: device terminal
bytes stream to **stdout**, and any error/summary goes to **stderr** (so the two
never interleave — the same split as `transfer download -`). On a clean session
close the exit code is `0`; a pre-stream failure (bad transport, auth, no route)
emits the standard error envelope on stderr and exits `1`.

Two input modes, chosen by whether stdin is a TTY:

- **Interactive** (stdin is a TTY): raw-mode stdin → the session, device output →
  stdout, the real terminal size is reported to the device, and `SIGWINCH`
  forwards resizes. This is the human path; it is described in T4 and verified by
  hand (a piped test cannot be a TTY).
- **Batch** (stdin is a pipe/file): bytes are forwarded as typed and the session
  closes when stdin reaches EOF (after a short output drain). This is what the
  harness drives — pipe a command in, read the device's response off stdout.

Conventions (provided by the harness):

- `$MAC` is the CHR target interface MAC; `$U` / `$P` are MAC-Telnet credentials.
- `$HOST` / `$UDP` point the UDP transport at the loopback L2 bridge
  (`--host 127.0.0.1 --port <bridge udpPort>`), exactly as the `execute /
  mac-telnet` command-path test does. A real call omits these and lets the
  adapter discover the L2 route.

## CHR-tested (T1–T3)

### T1. Run a command over a MAC-Telnet terminal (batch relay)

Pipe a CLI line into the terminal; the device's response appears on stdout.

```bash
printf '/system/identity/print\n' | centrs terminal $MAC --via mac-telnet --host $HOST --port $UDP --username $U --password $P
```

stdout contains the device identity (cross-checked against REST). Exit code `0`.
RouterOS 7.23.6/7.24.3/7.25beta4 print a one-property menu's value one
character per line (GH#352), so the comparison collapses `print` column
wrapping on both sides rather than asserting the device's layout.

### T2. `--via rest-api` has no terminal capability

```bash
centrs terminal $MAC --via rest-api --username $U --password $P
```

Envelope on stderr: `ok: false`, `error.code="transport/capability-unsupported"`.
Exit code `1`. No bytes on stdout.

### T3. `--via native-api` has no terminal capability

```bash
centrs terminal $MAC --via native-api --username $U --password $P
```

Same contract as T2: `transport/capability-unsupported` on stderr, exit `1`.

## Interactive (verified by hand, not in CI)

### T4. Open an interactive console to a MAC

```bash
centrs terminal $MAC --username $U --password $P
```

A MAC target with no `--via` selects `mac-telnet` (the L2 default). stdin goes
into raw mode; keystrokes reach the device and its output paints stdout. The real
terminal rows/cols are reported to the console (so it neither wraps nor paginates)
and a window resize forwards via `SIGWINCH`. `Ctrl-D` / session end exits `0`.

## ssh (`--via ssh`)

`terminal / ssh` execs the **host `ssh`** with inherited stdio: RouterOS grants no
pseudo-tty, but `ssh user@host` opens the interactive console and the OS relays it
(the no-PTY stream is already clean — no screen emulation). centrs's value is
resolving the target/key/trust and building the argv; the interactive TTY, raw
mode, and signals are the inherited terminal's. A **host target defaults to ssh**
(a MAC target defaults to mac-telnet). Because the session is interactive, the
terminal argv omits `BatchMode=yes` (the batch sftp/execute clients keep it), so
the host `ssh` may prompt on the TTY for an encrypted key's passphrase or a
password — centrs does not forward `--password`, since OpenSSH takes no password
on the argv.

Harness inputs (from `test/integration/terminal-ssh.test.ts`): `$SSH_PORT` is
`chr.sshPort` (passed via `--port`), and `$KEY` is the ephemeral private key the
test mints with `ssh-keygen -f <tmp>/id` and passes via `--ssh-key`. **TS1, TS2,
TS4 and TS5 are the CHR-tested set**. The matrix's `CHR-passed` claim rests on
TS1, TS2 and TS4. TS1, TS2 and TS5 run in `test/integration/terminal-ssh.test.ts`; TS4 runs in the shared
`test/integration/ssh-identity.test.ts`. **TS3 is the interactive hand-verified
analog of T4** (a piped subprocess stdin cannot be a TTY), not in CI.

### TS1. Run a command over an SSH terminal (batch relay)

```bash
printf '/system/identity/print\n/quit\n' | centrs terminal 127.0.0.1 --via ssh --port $SSH_PORT --username $U --ssh-key $KEY --insecure
```

stdout contains the device identity (cross-checked against REST).
RouterOS 7.23.6/7.24.3/7.25beta4 print a one-property menu's value one
character per line (GH#352), so the comparison collapses `print` column
wrapping on both sides rather than asserting the device's layout. centrs returns
ssh's exit code (a no-PTY console closed by EOF can exit non-zero — that is the
device/ssh's result, not a centrs failure; a clean `/quit` from a real TTY exits
`0`).

### TS2. `--via rest-api` has no terminal capability

```bash
centrs terminal 127.0.0.1 --via rest-api --username $U --password $P
```

Envelope on stderr: `ok: false`, `error.code="transport/capability-unsupported"`,
exit `1` — same gate as mac-telnet's T2/T3, evaluated before any connection.

### TS3. Open an interactive console over SSH (verified by hand, not in CI)

```bash
centrs terminal 192.0.2.10 --username $U --ssh-key $KEY
```

A host target with no `--via` selects `ssh`. The inherited terminal hands the
RouterOS console to the user; `/quit` (or `Ctrl-D`) ends the session. RouterOS's
no-PTY limitation applies (e.g. multi-line brace blocks are not supported over
SSH — see the SSH page); single-line commands work.

### TS4. A rejected selected key cannot authenticate through another agent identity

The shared [SSH identity example S5](../execute/examples.md#s5-an-explicit-rejected-key-cannot-fall-back-to-an-unrelated-agent-key)
checks the real terminal relay against CHR with a private agent and prompts
disabled. The rejected key preserves OpenSSH's nonzero exit and
`Permission denied`; selecting the trusted key or leaving the key unset
returns the device identity. Covered by `test/integration/ssh-identity.test.ts`.

### TS5. `--host` stands in for `<router>` (#428)

```bash
printf '/system/identity/print\n/quit\n' | centrs terminal --host 127.0.0.1 --port $SSH_PORT --username $U --ssh-key $KEY --insecure
```

There's no `<router>` and no `--via`. The host-only target selects ssh, as a
host `<router>` does, with no CDB lookup. stdout contains the device identity,
checked as in TS1.

## quickchr targets (TQ1–TQ3, #610)

`$NAME` is the machine name of a running quickchr-managed CHR. TQ1–TQ2 are
covered by `test/integration/quickchr-target.test.ts`, which shares that suite's
CHR boot (booted with quickchr secure login, so it has a managed key).
The no-CHR error paths (repeat, positional, override conflicts, unknown machine)
are unit tests in `test/unit/terminal.test.ts`.

### TQ1. Open an ssh console on a quickchr machine (batch relay)

```bash
printf '%s\n' '/system/identity/print' ':put ("ssh-user=" . [/user/active/get [find where via="ssh"] name])' '/quit' | centrs terminal --quickchr $NAME
```

No `--via`, host, port, user, or key: the descriptor's SSH endpoint supplies
them, and the session logs in with quickchr's batch-verified managed key (the
harness boots the CHR with quickchr `secureLogin`, which provisions one).
stdout contains the device identity (checked as in TS1) and
`ssh-user=<descriptor user>`, RouterOS's own record of who holds the login. After
`/quit` and stdin EOF the process exits, and the router's `/user/active` lists
no ssh session.

### TQ2. `--via mac-telnet` on a quickchr target → `quickchr/unsupported-via`

```bash
centrs terminal --quickchr $NAME --via mac-telnet --json
```

Envelope on stderr: `ok: false`, `error.code="quickchr/unsupported-via"`, exit
`1`, no bytes on stdout. quickchr v1 forwards no mac-telnet service, and centrs
never swaps a pinned `--via` for ssh.

### TQ3. A machine with no verified key → `quickchr/ssh-auth-unavailable`, then bring your own key

```bash
centrs terminal --quickchr $NAME --json
centrs execute --quickchr $NAME '/user/ssh-keys/add user=<user> key="<public key>"' --yes --json
printf '/system/identity/print\n/quit\n' | centrs terminal --host <host> --port <port> --username <user> --ssh-key $OWN_KEY --insecure
```

`$NAME` here is a machine booted **without** quickchr secure login (the
`test/integration/terminal-ssh.test.ts` harness), so its descriptor vouches for
no SSH key. The first call's envelope on stderr is `ok: false`,
`error.code="quickchr/ssh-auth-unavailable"`, exit `1`, no bytes on stdout; the
remediation names `--secure-login`, and `error.context` carries
`host`/`port`/`username`. Following the remediation, the key install over the
machine's non-SSH service succeeds, and the direct console, filled in from that
context with `$OWN_KEY` (minted by the test), prints the device identity with
no agent and no password prompt available. Covered by
`test/integration/terminal-ssh.test.ts`.

## MAC target over `--via ssh` resolution (behavior note — not a numbered CHR example)

This path resolves a MAC to an IP and, on the unresolved / no-opt-in branch,
fails before reaching any router — so it is **not** a numbered CHR integration
example. It is covered by the network-free smoke tier
(`test/integration/cli-smoke.test.ts`, JG-01) and `test/unit/{terminal,mac}.test.ts`.

```bash
centrs terminal aa:bb:cc:dd:ee:ff --via ssh --username $U --json
```

A MAC pinned to the IP transport needs an IP. With no matching CDB record and the
default `--resolve none`, the envelope on stderr is `ok: false`,
`error.code="target/mac-unresolved"`, exit `1` — and the remediation leads with
`--via mac-telnet` (reach it over L2, no IP needed). `--resolve arp` opts into the
host ARP cache instead; a miss is `target/mac-not-in-arp`. centrs never resolves a
MAC over ARP, or swaps to another transport, on its own (see
`commands/terminal/README.md` → *MAC target over SSH*).
