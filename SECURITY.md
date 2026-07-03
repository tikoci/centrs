# Security Policy

## Reporting a Vulnerability

Report privately via [GitHub Security Advisories](https://github.com/tikoci/centrs/security/advisories/new). Do **not** open a public issue for an undisclosed vulnerability.

Please include the affected files or workflow, reproduction details, and impact. Initial response within a few business days; fixes land on `main` and flow into the next published artifact.

## Scope

`centrs` will mediate RouterOS device access, credentials, local discovery data, and optional HTTP/MCP proxy surfaces. Security-sensitive areas include credential import/cache, RouterOS write execution, local network discovery, file transfer, and any daemon that binds a network port.

## Code scanning

The repository's [Security tab](https://github.com/tikoci/centrs/security) is the live source of current alerts and advisories. This section describes *what* checks run and *why*, so the doc stays meaningful even when the badge is at 0.

- **CodeQL** — repo-managed workflow at [`.github/workflows/codeql.yaml`](.github/workflows/codeql.yaml) with config [`.github/codeql-config.yml`](.github/codeql-config.yml). Query suite: `security-and-quality` (security-extended + code-quality) plus a small custom pack, [`.github/codeql-house-rules/`](.github/codeql-house-rules/), that structurally checks a handful of repo-specific invariants (currently: `apiFanout` must call its named protocol/validation gates) — see `.github/instructions/github-security-quality.instructions.md` for scope and the verify-before-promote discipline for adding more rules there. Languages: `javascript-typescript`, `actions`. Schedule: push to `main`, pull requests to `main`, weekly cron, and manual dispatch.
- **Code Quality (AI findings, preview)** — confirmed active in GitHub as of 2026-07-03 (not just "intended"; see [issue #166](https://github.com/tikoci/centrs/issues/166)). [`.github/workflows/codeql.yaml`](.github/workflows/codeql.yaml) includes a non-failing forward-compat probe for a future AI-findings API. AI findings are noisy and self-contradicting; we accept the noise because the second-opinion catches real issues that the static suite misses. Steady-state goal is 0 open findings. False positives are dismissed via the GitHub UI with a written justification — that text is the audit-log contract. Side effect: GitHub's own Code Quality scan runs in parallel with our Advanced Setup and posts a same-named `Analyze (javascript-typescript)` check, so PR checks lists show it twice — cosmetic, tracked in #166, not a required check either way (see issue #118).
- **Dependency review** — not enabled. GitHub dependency review follows dependency-graph ecosystem support, and this Bun-only repository currently does not have a supported lockfile for that gate.
- **Dependabot security updates** — enabled and configured in [`.github/dependabot.yaml`](.github/dependabot.yaml).
- **Secret scanning** — enabled in GitHub, with push protection.
- **Private vulnerability reporting** — enabled via GitHub Security Advisories.

Some GitHub Security tab data, especially Code Quality AI findings, is not reachable through the default workflow `GITHUB_TOKEN` (`repos/{owner}/{repo}/code-quality/findings` 403s there even with `security-events: read`) — it does respond with an elevated/owner-scoped token, but no findings have been recorded yet to confirm the response shape end-to-end (see #166). Human review in the GitHub UI remains part of the security workflow until that's wired up.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | yes |
