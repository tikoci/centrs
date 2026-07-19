# transfer

Copy files to and from a RouterOS device, and manage device files.

Status (agrees with `docs/MATRIX.md`): `CHR-passed` for `rest-api` / `native-api`
and for `ssh`/**sftp** (`src/transfer.ts`, `src/cli/transfer.ts`,
`src/protocols/sftp.ts`). `test/integration/transfer.test.ts` is green against a
real CHR 7.23.1 (110 assertions): the rest + native round-trip, list + filters,
validate-before-write, device file management (mkdir/copy/remove), leading-slash
normalization, the >60 KB REST-write rejection, the error contract, the
stdin/stdout/default-local forms (examples 8–10, driven through the real CLI
binary via the subprocess harness `test/integration/cli-process.ts`), the native
`N1`–`N4` mirror, the sftp `S1`–`S5` round-trip (key-auth, the >60 KB upload REST
cannot do, list/mkdir/remove), and example 17 (chunked REST read of an
sftp-seeded >60 KB file) — confirming the `/file`
`get`/`set`/`add`/`copy`/`remove` wire shapes and the SFTP subsystem on real
RouterOS. Unit coverage is `test/unit/transfer.test.ts`. **sftp** is the first SSH
consumer — a self-contained SFTP transfer client over the host OpenSSH `sftp`
subsystem. `scp` and `fetch` are **designed but deferred** past this pass.
Multi-target fan-out is built (see **Target selection**, examples F1–F5).

## Intent

`transfer` is centrs's file verb. Direction is explicit in the sub-verb —
`upload` is host → device (the WinBox "upload files" direction), `download` is
device → host. It honors the same `<router>` resolution, credentials, envelope,
and settings as every other command (see [`docs/CONSTITUTION.md`](../../docs/CONSTITUTION.md)
for identity/CDB resolution and the result envelope). Large transfers are exempt
from the REST 60 s timeout cap because they do not ride a single REST request.

centrs does not pick one method for you and hope; it picks the **cheapest method
that can carry this file in this direction**, reports the choice in
`meta.via`, and never silently crosses an explicit `--via`. See *Method
selection*.

## Synopsis

```text
centrs transfer <router> upload   <local> [<remote>] [flags]
centrs transfer <router> download <remote> [<local>] [flags]
centrs transfer <router> list     [<path>] [flags]
centrs transfer <router> remove   <remote> [flags]
centrs transfer <router> mkdir    <remote> [flags]
centrs transfer <router> copy     <remote-src> <remote-dst> [flags]   # on-device
```

- `<router>` — IP, DNS, MAC, or CDB-resolved name. See constitution: identity.
- `<local>` — a host path, or `-` for stdin (`upload`) / stdout (`download`), so
  `transfer` composes in shell pipelines. If omitted, `download` writes the
  remote basename into the current directory.
- `<remote>` — a RouterOS file path (e.g. `flash/fw.rsc`). If omitted on
  `upload`, centrs uses the **local basename**. *(Planned: prefer the device's
  `flash` disk — `flash/<basename>` — when one is present.)*
- Remote paths match RouterOS exactly — no path rewriting. RouterOS file names
  carry **no leading slash** (`/file/print` shows `flash/fw.rsc`), but the
  `/file/add name=/flash/…` form *accepts* one, so centrs accepts a leading `/`
  for ergonomics and **normalizes it away** to the canonical no-slash form used
  on the wire (REST `/file` keys and SFTP paths both want it stripped).
  `flash/fw.rsc` and `/flash/fw.rsc` are the same target.
- Reboot-persistence: on devices that have a `flash` disk, anything stored
  **outside** `flash/` lives on a RAM disk and is lost on reboot — so prefer an
  explicit `flash/…` remote on such devices. CHR has no `flash` disk —
  everything persists. *(Planned: detect a `type=disk name=flash` row to default
  omitted uploads into `flash/` and warn on an explicit non-`flash/` path;
  centrs never silently relocates an explicit path.)*

`list` is thin sugar over `retrieve <router> /file` (a `/file/print` menu read),
rendered for humans (human-readable sizes, `flash/` tree, `.npk` package
metadata). For RouterOS-side row queries beyond `--type` / `--name`, use
`retrieve /file --query` directly.

### Top-level shortcuts

`upload` and `download` are also promoted to **top-level command aliases** for the
two highest-frequency operations, so the router stays the first positional:

```text
centrs upload   <router> <local> [<remote>] [flags]   →  centrs transfer <router> upload   <local> [<remote>]
centrs download <router> <remote> [<local>] [flags]   →  centrs transfer <router> download <remote> [<local>]
```

They are pure aliases (identical flags, envelope, and validation); help and docs
show the canonical `transfer …` form, and the shared "did you mean?" / level-aware
help applies. Only `upload`/`download` are promoted — `list`/`remove`/`mkdir`/
`copy` stay under `transfer` because those verbs would be ambiguous at the top
level (every command can list or remove something).

## Method selection

The RouterOS file plumbing is asymmetric, so the default is direction- and
size-aware. Grounding: [Files](https://help.mikrotik.com/docs/spaces/ROS/pages/2555971/Files),
[Fetch](https://help.mikrotik.com/docs/spaces/ROS/pages/8978514/Fetch).

| Method (`--via`) | Grid transport | download (device → host) | upload (host → device) |
| ---------------- | -------------- | ------------------------ | ---------------------- |
| `rest` / `native` | rest-api / native-api | small via `/file/get … contents` (**≤ 60 KB**); **large via chunked `/file/read offset chunk-size≤32768`** | **`/file/set contents=` ≤ 60 KB only** — no chunked write |
| `sftp` (default secure) | ssh | any size | any size |
| `scp` | ssh | any size | any size |
| `fetch` *(deferred)* | rest-api/native-api + inbound HTTP | router PUTs to centrs (`upload=yes http-method=put src-path=…`) | router GETs from centrs (`url=http://centrs/… dst-path=…`) |
| `ftp` *(gated)* | ftp | any size | any size |

Auto-selection (no `--via`):

- **download** — `rest`/`native` for everything (chunked `/file/read` scales to
  any size with no SSH service required); fall back to `sftp` only if the REST
  family is unreachable.
- **upload ≤ 60 KB** — `rest`/`native` (`/file/set contents`); one round trip, no
  SSH needed.
- **upload > 60 KB** — `sftp`. The REST family cannot write past 60 KB, and
  `fetch` is the only REST-family way to push a large file without SSH — but it
  needs inbound reachability we can't assume, so it is **explicit-only** (see
  below), never auto-selected.

Every auto hop is reported in `meta.warnings` with its reason. An explicit
`--via` is never silently downgraded: if you pin `--via rest` and ask to upload a
2 MB file, centrs fails with `transport/unsupported-operation` (REST cannot write
past 60 KB) rather than quietly switching to sftp. `scp`, `fetch`, and `ftp` are
explicit-only; `ftp` additionally requires `ALLOW_UNSAFE_PROTOCOLS=ftp` because
it is cleartext.

> Future methods documented so callers know the capability exists, behind an
> explicit `--via`: `/system/smb` (not enabled by default) and `rose-storage`
> (`rsync`/`nfs`/`nvme-over-tcp`/`iscsi`, needs `rose-storage.npk`).

### SFTP vs SCP (why sftp is the SSH default)

RouterOS supports both over its SSH server, and MikroTik documents both — their
container guides use `sftp admin@<router>` to push/pull config files
([example 1](https://help.mikrotik.com/docs/spaces/ROS/pages/172294200/Container%2B-%2Bfreeradius%2Bserver),
[example 2](https://help.mikrotik.com/docs/spaces/ROS/pages/169246787/Container%2B-%2Bmosquitto%2BMQTT%2Bserver)),
while the [CHR-ProxMox guide](https://help.mikrotik.com/docs/spaces/ROS/pages/48660553/CHR%2BProxMox%2Binstallation)
uses `scp`. centrs makes **sftp the default and the primary investment**; `scp`
is an explicit `--via scp` escape hatch. The reason is capability, not taste:

- **SFTP is a real protocol** — `stat`, `readdir`, partial reads/writes, `mkdir`,
  `remove`, `rename`. Those are exactly what centrs's feature set needs: the
  validate-before-write existence check (`stat` the target) and the
  `list`/`remove`/`mkdir` verbs all fall out of SFTP. (`--verify size` is still
  supported over sftp — it just trusts the SFTP transfer guarantee rather than
  re-reading a settled size, since RouterOS's `ls -l` has no reliable size column;
  see *Integrity*.)
- **SCP is a dumb byte-stream** — no stat, no listing, no existence check; it just
  blasts bytes and truncates on collision. An `--via scp` upload therefore
  **cannot do the existence check itself** and would need a side-channel REST/SFTP
  `stat` anyway — so `--via scp` skips the refuse-overwrite guard unless REST is
  also reachable, and `--verify` degrades to `off` (warned). scp buys only a
  marginally lighter single-file stream, irrelevant under the CHR 1 Mb/s cap.
- **Direction of the ecosystem** — OpenSSH deprecated the legacy SCP wire protocol
  (9.0, 2022); modern `scp` rides SFTP underneath, so the reliable SSH file channel
  is the **SFTP subsystem**, not an exec-driven copy. (RouterOS's SSH server has no
  pseudo-tty, but a single-line `ssh user@host "<command>"` *does* run and return
  clean output — that path drives `execute / ssh`, see `commands/execute/README.md`;
  it is not a file-transfer channel.)

## Flags

Implemented flags are generated from the CLI metadata into
[`docs/CLI.md` → transfer](../../docs/CLI.md#transfer); this file does not
duplicate that table. Behavior notes the generated reference cannot carry:

- `--force`/`--overwrite` applies to the destination side (the local file for
  `download`, the remote file for `upload`); the default refuses an existing
  target with `usage/target-exists` (see *Validation*).
- `--verify` details and the sftp size caveat are in *Integrity*.
- `--timeout`: `rest`/`native` are per-request ≤ 60000 ms (a chunked read is
  many short requests, each capped); `sftp` accepts longer for a single large
  transfer.
- `--ssh-key` is the same `sshKey` setting as `terminal`/`execute`
  (`CENTRS_SSH_KEY`, CDB `ssh-key=`); when unset, the ssh-agent /
  `~/.ssh/config` is used. See `commands/terminal/README.md`.
- `--insecure` adds a `transport/insecure-trust` warning (constitution:
  transport trust).
- `--quickchr` resolves host/port/auth from the live `@tikoci/quickchr`
  (0.4.5+, optional dependency) descriptor. `--via sftp` additionally
  requires the descriptor's SSH endpoint to advertise a batch-capable auth
  mode, else `quickchr/unsupported-via` (never a password prompt).

### Designed, not implemented

Spec-tier flags with no implementation yet — today they fail as unknown flags:

| Flag | Designed behavior |
| ---- | ----------------- |
| `--advertise-host <host>` / `--advertise-port <n>` / `--bind <addr>` | `fetch` only *(deferred)*: the host/IP/port centrs advertises in the fetch URL and the local bind address. Default: auto-detect the local IP on the route to the router; ephemeral port; single-use random URL token. |
| `--resolve <none\|arp>` | Resolve a MAC-address target to an IP via the host ARP cache. Default `none`. |

## Target selection

`transfer` runs the **same** verb across a multi-target selection over the shared
grammar (multiple `<router>` positionals, repeatable `--group`/`--where`, the geo
selectors `--near`/`--bbox`, `--all`, `--default`). The grammar, the locked
`FanoutData` envelope, the record-order
reassembly, and the granular **0/2/1 exit code** are normative in
[`docs/CONSTITUTION.md` → Target selection grammar](../../docs/CONSTITUTION.md#target-selection-grammar).

The positional **boundary is the verb keyword** (`upload`/`download`/`list`/
`remove`/`mkdir`/`copy` or an alias): positionals **before** it are fan-out
targets, the verb and its paths follow (`transfer r1 r2 download /flash/log.txt
--out-dir ./logs`). A single positional target with no selector stays
single-target. On the top-level `upload`/`download` alias the verb is fixed, so
its positionals are paths — positional fan-out targets are not expressible there;
fan-out comes from a selector flag.

Two transfer-specific rules:

- **`download` fan-out requires `--out-dir <dir>`.** N devices cannot share one
  local path, so each target's file is written into the directory, named by its
  CDB identity (collision-safe — same-label targets are disambiguated by record
  index — and keeping the remote file's extension). Each inner envelope records
  its per-target local path.
- **`upload`/`remove`/`mkdir`/`copy` are device writes**, so a fan-out of them is
  gated by **`--yes`**, confirmed once up front; without it the error names the
  blast radius (how many routers). `download`/`list` only read the device.

## Integrity

`--verify size` (default) over `rest`/`native` reads the settled `/file` size
after the transfer and compares it to the byte count centrs moved. Over **sftp**,
RouterOS's `ls -l` reports no reliable byte size (CHR 7.23.1), so `--verify size`
instead trusts the SFTP transfer guarantee — a partial `put`/`get` errors — rather
than re-reading a size. Two RouterOS facts shape the `/file`-size path:

- **NAND write-back** delays the flush up to ~40 s on some devices, so the size
  may read short immediately after an upload. centrs does a single post-write
  `/file/print` size probe today. *(Planned: a brief poll/retry to absorb the
  write-back window before declaring a mismatch.)*
- **Transparent compression**: the `/file` menu reports the *uncompressed* size
  (compression only shows up in `/system/resource` free space), so size-compare
  against the uncompressed byte count we sent stays valid.

A confirmed shortfall (clear truncation after the poll window) is
`transport/incomplete-transfer`. `--verify checksum` is stronger but only where
RouterOS exposes a usable digest; otherwise it degrades to `size` with a warning.

## Output shape

The downloaded/uploaded bytes go to disk (or stdout for `download -`); the
envelope carries transfer *metadata*, not file contents.

```ts
{
  ok: true,
  data: {
    op: "upload",                 // upload | download | list | remove | mkdir | copy
    remote: "flash/fw.rsc",
    local: "./fw.rsc",            // null for list/remove/mkdir/copy
    bytes: 1048576,
    verified: "size",             // size | checksum | off
    durationMs: 1840
  },
  warnings: [],                   // e.g. auto-method hops, insecure-trust
  meta: { target, via: "ssh", settings, validation, timing }  // via is the grid transport: rest-api | native-api | ssh
}
```

`list` returns `data` as the `/file` row array (same shape as
`retrieve /file`). Fanout returns the shared one-outer-envelope form documented
in `commands/retrieve/README.md` (Group fanout): `ok` reports orchestration
success, per-target results live in `data.targets`.

## Validation

`transfer` validates what it can locally first — conflicting flags
(`usage/conflicting-flags`), a missing local source on `upload`, a `--via rest`
upload that exceeds 60 KB (`transport/unsupported-operation`). The
**refuse-overwrite** guard is a real precondition probe, not a local check:
unless `--force`, centrs `stat`s the destination (SFTP `stat`, or `/file/print`
for the REST family) and fails with `usage/target-exists` if it is already there.
This is the "validate before write" gate applied to files — see constitution:
validation is the product.

The `/file` menu path is fixed, so there is no `/console/inspect` path/attribute
gate as in `retrieve` / `execute`; RouterOS's own menu errors (missing remote
file, permission denied) map to `routeros/*`, and SFTP/SCP/fetch errors map to
`transport/*` and `auth/*`.

**Error codes reuse existing namespaces — `transfer` adds no namespace of its
own.** Everything specific to transfer fits `usage/*` (`usage/target-exists`),
`transport/*` (`transport/unsupported-operation` for the REST 60 KB write cap,
`transport/incomplete-transfer` for a verified shortfall, `transport/unreachable`
for fetch inbound-reachability), `routeros/*`, `auth/*`, and `validation/*`. A new
code is only justified where the *semantics* are genuinely file-transfer-specific
and not already expressible in those namespaces.

## Decided (2026-06-10)

- **Verbs are `upload` / `download` / `list`** (+ `remove` / `mkdir` / `copy` for
  device file management). Direction is explicit in the sub-verb; `upload` =
  host → device per WinBox wording. **`copy` needs RouterOS ≥ 7.23beta2**:
  server-side copy rides the REST `/file/copy` endpoint, first seen in 7.23beta2;
  earlier RouterOS (e.g. 7.21.x long-term) returns `no such command` (the
  integration test gates the `copy` example on the running version).
- **Method selection is size/direction-aware** (table above), superseding the
  earlier "sftp is always the default" decision. REST/native carry small writes
  and all reads (reads scale via chunked `/file/read`); sftp carries large
  uploads. This updates the constitution's protocol-selection row.
- **sftp is the SSH default, scp is `--via scp` only** — sftp's `stat`/`readdir`/
  partial ops are what enable the existence check, `--verify`, and
  `list`/`remove`/`mkdir`; scp can't do those and degrades the overwrite guard and
  `--verify`. See *SFTP vs SCP*.
- **Remote paths match RouterOS** (no rewriting); a leading `/` is accepted but
  normalized away to the canonical no-slash wire form. The omitted-`<remote>`
  default uses `flash/` on devices that have a flash disk.
- **`upload` / `download` are also top-level command aliases** (`centrs upload
  <router> …`), the only sub-verbs promoted to the top level.
- **Error codes reuse existing namespaces** — no `transfer/*` namespace; new codes
  only where the semantics are genuinely transfer-specific.
- **`fetch` (centrs-as-HTTP-server + `/tool/fetch`) is explicit-only and
  deferred** — designed here, built after sftp + REST land. It is the only
  REST-family way to push a > 60 KB file without SSH, but needs inbound
  reachability (router → centrs), so it is never auto-selected.
- **v1 includes** device file management (`remove`/`mkdir`/`copy`), integrity
  verification (`--verify`), and stdout/stdin piping (`-`). **Directory /
  recursive transfer is a later phase.**
- **CI proof is a small-file round-trip**, not a throughput stress test — the
  free CHR license caps throughput at 1 Mb/s.

## Definition of done

`CHR-passed` only when every line in `examples.md` runs green against a real CHR
through `bun run test:integration` (one example ↔ one assertion). Disabling
validation to reach green is forbidden. See `docs/CONSTITUTION.md` for the full
done rule. The first coded pass targets `rest`/`native` (no SSH dependency);
`sftp`/`scp` advance with the SSH transport; `fetch` and `ftp` follow.

## Notes for future cells

- **fetch design (deferred).** centrs starts an ephemeral single-use HTTP server
  (random URL token, bound to the interface facing the router) and drives the
  router with `/tool/fetch` over `rest`/`native`. **upload**: serve the local
  file, `fetch url=http://<advertise>/<token> dst-path=<remote>` → router GETs.
  **download**: `fetch upload=yes http-method=put url=http://<advertise>/<token>
  src-path=<remote>` → router PUTs to centrs (`http-method` any since 7.21;
  binary REST serialization fixed 7.17). Open questions: advertise-host
  auto-detection behind NAT, HTTP-vs-HTTPS + `check-certificate`, and whether to
  add fetch's `user`/`password` on top of the URL token.
- **ssh** — `sftp` is **built** (`src/protocols/sftp.ts`, host OpenSSH `sftp`
  subsystem; `scp` is the deferred follow-on). The host SSH client owns
  host-key/agent/algorithm negotiation; the centrs-side trust knob is the unified
  `--insecure` (constitution: transport trust). Two RouterOS auth facts transfer
  inherits, grounded on the [SSH](https://help.mikrotik.com/docs/spaces/ROS/pages/132350014/SSH)
  / [User](https://help.mikrotik.com/docs/spaces/ROS/pages/8978504/User) pages:
  **by default** a user cannot password-auth over SSH once an SSH key is set for it
  (`/ip/ssh password-authentication=yes-if-no-key`, the default — settable to
  `yes` to allow both), so key auth is the normal path; and `strong-crypto=yes`
  disables ssh-rsa/SHA1, so the client must offer ed25519 / rsa-sha2-256 (the host
  OpenSSH negotiates this natively). The SSH file path is the SFTP **subsystem**
  (a real file protocol), not exec-driven scp; on-device `copy`
  has no SFTP primitive and stays on rest/native (`--via sftp copy` →
  `transport/unsupported-operation`). See `commands/terminal/README.md` (RouterOS
  SSH surface) for the full device-side option alignment.
- **list ↔ retrieve** — `transfer list` is sugar over `retrieve /file`; keep the
  read logic in one place.
