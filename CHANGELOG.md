# Changelog

All notable changes to this repository should be recorded here.

The product evolves as a stream of changes; there are no alpha gates.
Per-feature status is tracked in `docs/MATRIX.md`. Use this file for
documenting cross-cutting shifts that affect contributors and consumers.

## Unreleased

### Added

- **`btest / client` is now `CHR-passed`.** A direct centrs-client → CHR
  `/tool/bandwidth-server` gated test (`test/integration/btest-client.test.ts`)
  boots a CHR with a host→guest `tcp:2000` forward and runs the centrs client
  against real RouterOS: unauthenticated TCP receive, an **EC-SRP5 client proof
  verified by RouterOS's own server verifier**, and a wrong-password reject (CHR
  7.23.1). This closes the last open product-grid cell — the client cell was
  previously grounded only transitively (loopback + the server test). The
  integration harness (`test/integration/chr.ts`) gains an `extraPorts` option for
  arbitrary host→guest forwards. UDP client→server and TCP `connection-count > 1`
  fan-out remain loopback/transitive (README, Open questions).
- **CI/release rework — staged gate, definitive QA matrix, NPM publish, extended
  sweep.** The CI surface is reconciled with the tier/versioning doctrine
  (quickchr's `ci`/`publish`/`verify-extended` scheme as the reference).
  `ci.yaml` is a staged push/PR gate (lint ‖ unit+coverage → **stable CHR smoke**
  → cross-platform unit) with coverage + failing tests surfaced to job summaries
  and artifacts. `qa.yaml` is the definitive RouterOS channel matrix (push +
  weekly + dispatch + `workflow_call`) with **event-aware concurrency** (a new
  main push cancels the old run; dispatches never cancel one another — including
  an `all`-channels dispatch in a single run) and a `bun:sqlite` results store.
  `codeql.yaml` carries security/quality scanning on its own cadence.
  `release.yaml` publishes to npm on a `v*` tag (even/odd minor → `next`/`latest`,
  `--provenance`, dry-run) — **requires the `NPM_TOKEN` repo secret**.
  `verify-extended.yaml` adds a dispatch-only macOS-x86 / Windows-x86 sweep. New
  `chr-smoke` integration test + `test:integration:smoke` script; `.coderabbit.yaml`
  stages bot review to conserve credits.
- **QA recency-aware channel matrix + cross-run history + must-pass gate.**
  `qa.yaml`'s channel axis is now resolved per run by a `resolve-matrix` pre-flight
  job (`scripts/qa-active-channels.ts`) instead of a hard-coded list: it asks
  quickchr 0.4.2's public version/channel API (`resolveAllVersions` /
  `selectActiveChannels`, with the suffix-aware `compareRouterOsVersion` that
  finally orders `7.24beta2 < 7.24rc1 < 7.24`) for the channels *worth booting* —
  the released channels (stable, long-term) always, plus any pre-release (testing,
  development) at or ahead of stable. This closes the `testing` blind spot and
  auto-adapts as MikroTik promotes builds, because the four channels are not
  monotonically ordered (a stale `testing` rc is skipped; it is picked up
  automatically once it leapfrogs stable). A new `accumulate-and-gate` job appends
  each CHR run to a durable append-log on the `qa-history` branch (per-run
  artifacts have finite retention, and the channel→version drift over time is
  what a long history captures) and fails the run **only when a released
  channel (stable, long-term) regresses** — pre-release legs are best-effort, so a
  beta btest/EC-SRP5 flake (JG-31) is recorded but never reds main. Boundary:
  quickchr owns recency ("what's worth booting"); centrs owns the gate ("what must
  pass") — the must-pass policy lives once in `scripts/qa-results-db.ts`
  (`channelPolicy` / `evaluateMustPassGate`, mirrored by the matrix
  `continue-on-error`), with the cross-run accumulator in `scripts/qa-history.ts`.
- **`transfer / ssh` (sftp) — SSH lands transfer-first.** SSH joins centrs as a
  self-contained **SFTP transfer client** (`src/protocols/sftp.ts`) over the host
  OpenSSH `sftp` subsystem — the only reliable SSH file path, since RouterOS's SSH
  server has no exec channel / no pseudo-tty (so `execute`/`terminal` over SSH,
  which need an interactive-shell reader, are a deliberate later pass). This
  re-scopes the earlier "SSH lands as one unit" plan. `transfer` now routes
  `--via sftp` (and auto-selects it for >60 KB uploads, the gap the REST `/file`
  60 KB write cap leaves) through a new backend-agnostic `FileBackend` seam
  (`AdapterFileBackend` for rest/native, `SftpFileBackend` for sftp). The
  `ssh-key` (`--ssh-key` / `CENTRS_SSH_KEY` / CDB `ssh-key=`) and `insecure`
  settings land with the transport. **Green against real CHR 7.23.1** (98
  assertions, `test/integration/transfer.test.ts`): a key-auth sftp round-trip,
  the >60 KB upload, list/mkdir/remove, and example 17 (chunked REST read of an
  sftp-seeded file — the old fetch hack is gone). **CHR finding:** RouterOS's sftp
  `ls -l` does not report a reliable byte size, so the sftp `--verify size` trusts
  the SFTP transfer guarantee rather than re-reading a size. New error codes:
  `transport/host-key-mismatch`, `transport/insecure-trust`,
  `transport/auto-method`, `input/invalid-path`. On-device `copy` has no SFTP
  primitive and stays on rest/native.
- **Unified TLS / SSH host-key trust across every transport.** One opt-out —
  `--insecure` (`CENTRS_INSECURE`, CDB `insecure=`) — with verify-by-default and a
  `transport/insecure-trust` warning when it is set. REST (`fetch`) and native-api
  (`api-ssl`) now both **verify** TLS by default (native-api previously accepted
  any cert silently); a self-signed cert fails with `transport/tls-certificate`
  whose remediation names `--insecure`. SSH host keys default to
  `accept-new` trust-on-first-use; a changed key fails with
  `transport/host-key-mismatch`. See `docs/CONSTITUTION.md`, Transport trust.

- **`transfer` is `coded` for `rest-api` / `native-api`.** `src/transfer.ts` +
  `src/cli/transfer.ts` implement the file verb — `upload`/`download`/`list`/
  `remove`/`mkdir`/`copy` (plus top-level `upload`/`download` aliases) — over the
  RouterOS `/file` menu, driven through the shared `ProtocolAdapter`
  `execute`/`list` seam so REST and native share one path. Size/direction-aware
  method selection encodes the asymmetric `/file` plumbing (writes capped at
  60 KB via `/file/set contents`; reads scale via chunked `/file/read`), a
  `print`-probe enforces validate-before-write (refuse-overwrite unless
  `--force`), a leading `/` in a remote path is normalized away, and
  `sftp`/`scp`/`fetch`/`ftp` report a defined not-implemented / gated error.
  Unit-green via mocked `fetch` (`test/unit/transfer.test.ts`).
  `test/integration/transfer.test.ts` is green against a real CHR 7.23.1 (98
  assertions, after the sftp commit below also seeds example 17) — confirming the
  `/file` `get`/`set`/`add`/`copy`/`remove` wire shapes over both REST and native
  — covering all examples except the three deferred for harness reasons (8–10
  stdin/stdout/default-local), so the cells stay `coded` shy of the strict
  every-example `CHR-passed` bar. New error codes: `usage/target-exists`,
  `transport/incomplete-transfer`, `transport/checksum-unavailable`,
  `input/local-file-not-found`, `settings/unsafe-protocol-blocked`.
- **`discover / mndp` is `CHR-passed`.** A real layer-2 integration test
  (`test/integration/discover.test.ts`) boots a CHR with a second
  `socket-connect` NIC and a host bridge (`test/integration/mndp-l2-bridge.ts`)
  that lifts each frame's UDP/5678 payload into centrs's unmodified `discover()`
  listener and injects MNDP refresh frames back over the link. It captures and
  decodes a genuine RouterOS MNDP announcement (CHR 7.23.1), cross-checks
  `identity`/`platform`/`board`/`version`/`mac` against REST, and `--save`s a
  `macTarget`/`group=discovered` record. The `socket-connect` approach was first
  proven against quickchr's own `examples/mndp/` guinea-pig run. The same bridge
  (frame-injection write-back) is the L2 harness mac-telnet will reuse.

### Fixed

- **`btest` bidirectional TCP server tx is now accounted.** A `direction=both`
  TCP session reported `totalTxBytes=0` / `txAvgBps=0` on the server side even
  though it transmitted the client's receive half (hundreds of MB): the server's
  bulk-TX loop flushed only its rx into each interval, never its own tx. The
  server now records both halves, so a `both` session's `data.sessions[]` and the
  CSV/text renders carry a non-zero tx rate. Loopback-grounded
  (`test/unit/btest-{session,command}.test.ts`); UDP `both` and single-direction
  TCP were already correct.
- **`btest` totals now flush the final partial interval.** The per-interval
  accounting loops recorded totals on a tick cadence and exited without folding in
  bytes that arrived after the last tick (or before the first, on a slow host), so
  a short run under-reported the final fraction of a second of each direction.
  `driveSession` now folds the remaining counter bytes into the totals on stop,
  keeping `data.reports[]` lossless against them.
- **`discover` default listen window is now `15s`** (was `60s` in code).
  Lowering the window relied on the up-front refresh broadcast (sent immediately,
  then every 5s) so responders reply within a round-trip; the per-command docs
  already documented `15s`, but `DISCOVER_DEFAULT_TIMEOUT_MS`, the CLI help, and
  the MCP `centrs_discover` tool description still said `60s`. They now agree.

### Changed

- **Workflow restructure.** Replaced `docs/specs/`, `docs/WORKFLOW.md`,
  `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, and `work/` with three durable
  surfaces:
  - `docs/CONSTITUTION.md` — the load-bearing rules (validation as product,
    result envelope, error model + URL scheme, settings precedence, identity,
    protocol selection, done = CHR-passed).
  - `docs/MATRIX.md` — command×protocol grid; the only status surface.
  - `commands/<name>/{README,examples}.md` — per-command design and
    executable example list that gates "done."
- Done definition codified in
  `.github/instructions/done-definition.instructions.md`: a feature is done
  when its examples are green on real CHR via `bun run test:integration`.
  Disabling validation to make a test pass is forbidden; validation is the
  product.

### Removed

- `docs/specs/S001`–`S008`, `docs/WORKFLOW.md`, `docs/ROADMAP.md`,
  `docs/ARCHITECTURE.md`, all of `work/`, and the
  `docs-specs-lifecycle` / `work-directory` / `integration-testing`
  instruction files. Their durable content folded into the constitution and
  per-command files; the rest was scaffolding for a workflow that did not
  pay off.
