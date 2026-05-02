# Security Policy

## Reporting a Vulnerability

Report privately via [GitHub Security Advisories](https://github.com/tikoci/centrs/security/advisories/new). Do **not** open a public issue for an undisclosed vulnerability.

Please include the affected files or workflow, reproduction details, and impact. Initial response within a few business days; fixes land on `main` and flow into the next published artifact.

## Scope

`centrs` will mediate RouterOS device access, credentials, local discovery data, and optional HTTP/MCP proxy surfaces. Security-sensitive areas include credential import/cache, RouterOS write execution, local network discovery, file transfer, and any daemon that binds a network port.

## Code scanning

The repository's [Security tab](https://github.com/tikoci/centrs/security) is the live source of current alerts and advisories. This section describes *what* checks run and *why*, so the doc stays meaningful even when the badge is at 0.

- **CodeQL** — repo-managed workflow at [`.github/workflows/qa.yaml`](.github/workflows/qa.yaml) with config [`.github/codeql-config.yml`](.github/codeql-config.yml). Query suite: `security-and-quality` (security-extended + code-quality). Languages: `javascript-typescript`, `actions`. Schedule: push to `main`, pull requests to `main`, weekly cron, and manual dispatch.
- **Code Quality (AI findings, preview)** — intended to be enabled in GitHub. [`.github/workflows/qa.yaml`](.github/workflows/qa.yaml) includes a non-failing forward-compat probe for a future AI-findings API. AI findings are noisy and self-contradicting; we accept the noise because the second-opinion catches real issues that the static suite misses. Steady-state goal is 0 open findings. False positives are dismissed via the GitHub UI with a written justification — that text is the audit-log contract.
- **Dependency review** — not enabled. GitHub dependency review follows dependency-graph ecosystem support, and this Bun-only repository currently does not have a supported lockfile for that gate.
- **Dependabot security updates** — enabled and configured in [`.github/dependabot.yaml`](.github/dependabot.yaml).
- **Secret scanning** — enabled in GitHub; push protection is not currently enabled.
- **Private vulnerability reporting** — not enabled.

Some GitHub Security tab data, especially Code Quality AI findings, is not currently available through stable unauthenticated APIs. Human review in the GitHub UI remains part of the security workflow.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | yes |
