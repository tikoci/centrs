# Changelog

All notable changes to this repository should be recorded here.

The product evolves as a stream of changes; there are no alpha gates.
Per-feature status is tracked in `docs/MATRIX.md`. Use this file for
documenting cross-cutting shifts that affect contributors and consumers.

## Unreleased

### Added

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
  `test/integration/transfer.test.ts` is green against a real CHR 7.23.1 (92
  assertions) — confirming the `/file` `get`/`set`/`add`/`copy`/`remove` wire
  shapes over both REST and native — covering all examples except the four
  deferred for harness reasons (8–10 stdin/stdout/default-local and 17's
  fetch-seeded chunked read), so the cells stay `coded` shy of the strict
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
