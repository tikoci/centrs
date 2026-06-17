---
applyTo: "SECURITY.md,.github/workflows/codeql.yaml,.github/workflows/qa.yaml,.github/codeql-config.yml,.github/dependabot.yaml,src/**,package.json,bun.lock"
---

# GitHub security and quality scanning

Use `SECURITY.md` as the source-of-truth summary for scanning posture.

- Keep CodeQL configured with the `security-and-quality` suite for public tikoci repos unless a spec says otherwise.
- Treat the GitHub Security tab as the live alert state and aim for 0 open findings.
- AI findings are noisy; address each finding on its merits or dismiss false positives in the GitHub UI with written justification.
