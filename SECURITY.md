# Security Policy

## Reporting a Vulnerability

Report privately via [GitHub Security Advisories](https://github.com/tikoci/centrs/security/advisories/new). Do **not** open a public issue for an undisclosed vulnerability.

Please include the affected files or workflow, reproduction details, and impact. Initial response within a few business days; fixes land on `main` and flow into the next published artifact.

## Scope

`centrs` will mediate RouterOS device access, credentials, local discovery data, and optional HTTP/MCP proxy surfaces. Security-sensitive areas include credential import/cache, RouterOS write execution, local network discovery, file transfer, and any daemon that binds a network port.

## Code scanning

The repository's [Security tab](https://github.com/tikoci/centrs/security) is the live source of current alerts and advisories. This section describes *what* checks run and *why*, so the doc stays meaningful even when the badge is at 0.

- **CodeQL** — repo-managed workflow at [`.github/workflows/codeql.yaml`](.github/workflows/codeql.yaml) with config [`.github/codeql-config.yml`](.github/codeql-config.yml). Query suite: `security-and-quality` (security-extended + code-quality) plus a small custom pack, [`.github/codeql-house-rules/`](.github/codeql-house-rules/), that structurally checks a handful of repo-specific invariants (currently: `apiFanout` must call its named protocol/validation gates) — see `.github/instructions/github-security-quality.instructions.md` for scope and the verify-before-promote discipline for adding more rules there. Languages: `javascript-typescript`, `actions`. `test/` is excluded (`paths-ignore`); it is not shipped, and its CLI argv credentials over-tainted every CLI render path. Schedule: push to `main`, pull requests to `main`, weekly cron, and manual dispatch.
- **Code Quality** — GitHub's own scan, enabled in repository settings (not a workflow here). It runs as the separate "CodeQL - Code Quality" run on every PR and push and reports different findings from the CodeQL workflow above. Steady-state goal is 0 open findings. False positives are dismissed via the GitHub UI with a written justification — that text is the audit-log contract. Side effect: it posts a same-named `Analyze (javascript-typescript)` check, so PR checks lists show it twice — cosmetic (see [issue #166](https://github.com/tikoci/centrs/issues/166)), not a required check either way (see issue #118).
- **Code Quality AI findings** — not used: a paid feature, not enabled for this repository.
- **Dependency review** — not enabled. GitHub dependency review follows dependency-graph ecosystem support, and this Bun-only repository currently does not have a supported lockfile for that gate.
- **Dependabot security updates** — unsupported for Bun in GitHub's [ecosystem support table](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories). [`.github/dependabot.yaml`](.github/dependabot.yaml) configures weekly Bun **version updates** and GitHub Actions updates. Dependency security cleanup also requires `bun audit` and reviewed lockfile upgrades.
- **Secret scanning** — enabled in GitHub, with push protection.
- **Private vulnerability reporting** — enabled via GitHub Security Advisories.

Human review of the Security tab in the GitHub UI is part of the security workflow; no workflow gates on Code Quality findings.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | yes |
