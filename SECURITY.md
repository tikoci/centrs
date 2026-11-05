# Security Policy

## Reporting a Vulnerability

Report privately via [GitHub Security Advisories](https://github.com/tikoci/centrs/security/advisories/new). Do **not** open a public issue for an undisclosed vulnerability.

Please include the affected files or workflow, reproduction details, and impact. Initial response within a few business days; fixes land on `main` and flow into the next published artifact.

## Scope

`centrs` mediates RouterOS device access, credentials, and local discovery data through its library, CLI, and stdio MCP server. File transfer is available through the library and CLI. The explicitly invoked bandwidth-test server binds loopback by default (`--bind` can expose it) and requires authentication by default. TUI and HTTP proxy surfaces are planned; the MCP server has no network listener. Security-sensitive areas include credential import/storage, RouterOS write execution, local network discovery, file transfer, and network listeners.

## Credential handling

Since 0.1.9, `devices show`, `add`, and `set` withhold record passwords by
default in CLI and library output and report `passwordSet` instead (#551).
`--show-password` (library: `showPassword: true`) explicitly reveals them;
MCP results and resources always redact them. `--password-stdin` on
`devices add`/`set` keeps record passwords out of process arguments.
See the [devices contract](commands/devices/README.md#record-password-in-output).

CDB encryption is explicit: `devices init --encrypt` creates an encrypted
registry, and `devices encrypt` converts an existing open CDB. Conversion
retains existing backups and creates a plaintext snapshot unless
`--no-backup` is passed; that flag does not remove older backups. See the
[encryption contract](commands/devices/README.md#cdb-encryption-lifecycle-558).

## Device access and CDB integrity

0.1.10 rejects option-like host and username values before invoking SSH/SFTP,
ends their option parsing with `--`, and withholds attached values from unknown
CLI option diagnostics (#626, #627). TLS verifies peers by default; SSH uses
trust-on-first-use and rejects changed host keys. An explicit `--insecure`
disables peer verification; envelope-returning operations report a
`transport/insecure-trust` warning.

Record mutations and encryption conversion use a cross-process lock and check
the revision loaded by the caller before writing (#581). High-level library
mutations reject stale `LoadedCdb` snapshots with `cdb/conflict`. The low-level
`writeWinBoxCdb()` enables locking and revision checks only when supplied with
`expectedRevision`; omitting it skips both protections. `devices init` instead
uses atomic no-clobber creation. CLI/MCP add, set and remove operations and
`discover --save` reload and retry conflicting mutations. Lock contention
beyond 10 seconds fails `cdb/locked`. These protections prevent lost updates
between cooperating centrs writers; backups retain two prior versions by
default. Close WinBox before mutating the same CDB; external writers do not
take the centrs lock. See the [write contract](commands/devices/README.md#cdb-write-strategy).

The MCP allowlist requires registered targets, and RouterOS writes require
`mcp=rw` plus per-call `confirm: true`. **Known limitation
[#604](https://github.com/tikoci/centrs/issues/604):** authorization and dialing
read separate CDB snapshots. A concurrent edit or removal can change the
target or credentials after authorization, or allow a removed target to fall
through to an ad-hoc connection using fallback credentials. Avoid concurrent
CDB edits during MCP device calls. The mutation lock does not close this race.
This pre-existing defect remains open in 0.1.10; see the
[release known issues](CHANGELOG.md#known-issues).

## Code scanning

The repository's [Security tab](https://github.com/tikoci/centrs/security) is the live source of current alerts and advisories. This section describes *what* checks run and *why*, so the doc stays meaningful even when the badge is at 0.

- **CodeQL** — repo-managed workflow at [`.github/workflows/codeql.yaml`](.github/workflows/codeql.yaml) with config [`.github/codeql-config.yml`](.github/codeql-config.yml). Query suite: `security-and-quality` (security-extended + code-quality) plus a small custom pack, [`.github/codeql-house-rules/`](.github/codeql-house-rules/), that structurally checks a handful of repo-specific invariants (currently: `apiFanout` must call its named protocol/validation gates) — see `.github/instructions/github-security-quality.instructions.md` for scope and the verify-before-promote discipline for adding more rules there. Languages: `javascript-typescript`, `actions`. `test/` is excluded (`paths-ignore`); it is not shipped, and its CLI argv credentials over-tainted every CLI render path. Schedule: push to `main`, pull requests to `main`, weekly cron, and manual dispatch.
- **Code Quality** — GitHub's own scan, enabled in repository settings (not a workflow here). It runs as the separate "CodeQL - Code Quality" run on every PR and push and reports different findings from the CodeQL workflow above. Steady-state goal is 0 open findings. False positives are dismissed via the GitHub UI with a written justification — that text is the audit-log contract. Side effect: it posts a same-named `Analyze (javascript-typescript)` check, so PR checks lists show it twice — cosmetic (see [issue #166](https://github.com/tikoci/centrs/issues/166)), not a required check either way (see issue #118).
- **Code Quality AI findings** — not used: a paid feature, not enabled for this repository.
- **zizmor** — GitHub Actions static analysis, as the `Analyze (zizmor)` job in [`.github/workflows/codeql.yaml`](.github/workflows/codeql.yaml). Findings go to the Security tab and do not fail the job. [`.github/zizmor.yml`](.github/zizmor.yml) accepts tag refs (see GitHub Actions below) and turns off the Dependabot cooldown audit. `bun run lint:actions` runs it locally (needs `uv`); it is not part of `lint:ci`.
- **Dependency review** — not enabled. GitHub dependency review follows dependency-graph ecosystem support, and this Bun-only repository currently does not have a supported lockfile for that gate.
- **Dependabot security updates** — unsupported for Bun in GitHub's [ecosystem support table](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories). [`.github/dependabot.yaml`](.github/dependabot.yaml) configures weekly Bun **version updates** and GitHub Actions updates. Dependency security cleanup also requires `bun audit` and reviewed lockfile upgrades.
- **Secret scanning** — enabled in GitHub, with push protection.
- **Private vulnerability reporting** — enabled via GitHub Security Advisories.

Human review of the Security tab in the GitHub UI is part of the security workflow; no workflow gates on Code Quality findings.

## GitHub Actions

- **Action refs are tags, not commit SHAs** (`actions/checkout@v7`, `oven-sh/setup-bun@v2`), for first-party and third-party actions alike. Use the major tag; an action that publishes none (`zizmorcore/zizmor-action`) gets its release tag. This is a decision ([#266](https://github.com/tikoci/centrs/issues/266)), not an oversight, so a scanner's unpinned-action finding is not a defect here: CodeQL's `actions/unpinned-tag` is excluded in [`.github/codeql-config.yml`](.github/codeql-config.yml), and zizmor's `unpinned-uses` accepts tags in [`.github/zizmor.yml`](.github/zizmor.yml). A tag picks up an action's fixes, including security fixes, on the next run. A SHA pin goes stale silently until a bot bumps it. We accept the risk of a moved tag or a compromised release in exchange. Dependabot's weekly `github-actions` updates move major and release tags.
- **The Bun version lives in one place.** Every `setup-bun` step reads `packageManager` from `package.json` (`bun-version-file`); the Dockerfile base image is the only other copy.
- **Checkouts drop git credentials** (`persist-credentials: false`) unless the job pushes. The only one that pushes is the QA accumulate job in `qa.yaml`, which commits to the `qa-history` branch.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest stable patch (`latest` npm dist-tag) | yes; update to receive fixes |
| `main` | yes |
