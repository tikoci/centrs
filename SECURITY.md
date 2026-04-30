# Committed to Safety and Security

// CONTEXT: stores basic private vulnerability reports, and explain github for provenance, and docs codeql checks done (so source of truth for what CodeQL does)
// TODO: placeholder, copied from another project for a "templates" => should be carefully reviewed and aligned for this project

## Reporting a Vulnerability

Report privately via [GitHub Security Advisories](https://github.com/tikoci/restraml/security/advisories/new). Do **not** open a public issue for an undisclosed vulnerability.

Please include the affected files or workflow, reproduction details, and impact. If the issue affects generated `doc/` content, name the source file or workflow that produced it. Initial response within a few business days; fixes land on `main` and flow into regenerated published artifacts from there.

## Scope

> TODO

## Code scanning

The repository's [Security tab](https://github.com/tikoci/restraml/security) is the live source of current alerts and advisories. This section describes *what* runs and *why*.

> TODO: code was cut-and-paste from separate files, merged in a unified `qa.yaml` workflow here

- **CodeQL** — repo-managed workflow at [`.github/workflows/qa.yml`](.github/workflows/qa.yml) with `query` suite: `security-and-quality` (security-extended + code-quality). Languages: `javascript-typescript`, `actions`.  Runs on every release build.

> TODO: instructions should be clear before is **not** in GitHub MCP, `gh`, or GitHub APIs => only way for agent to see is if human creates a PR from GitHub website, otherwise agents have no way to see "code quality" issues

- **Code Quality (AI findings, preview)** — enabled. AI findings are noisy and self-contradicting; we accept the noise because the second-opinion catches real issues that the static suite misses. Steady-state goal is 0 open findings. False positives are dismissed via the GitHub UI with a written justification — that text is the audit-log contract.

> TODO: review qa.yaml just untested cut-and-paste

- **Dependency review** — Part of [`.github/workflows/qa.yml`](.github/workflows/qa.yml), `fail-on-severity: high` on pull requests.

> TODO: confirm enabled when at GitHub

- **Dependabot security updates** — enabled

> TODO: confirm enabled when at GitHub

- **Secret scanning** — enabled, with push protection.

> TODO: confirm enabled when at GitHub

- **Private vulnerability reporting** — enabled.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | under development |
