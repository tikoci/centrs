---
paths:
  - ".github/workflows/*.yaml"
  - ".github/workflows/*.yml"
---

CI should produce reviewable data, not just pass/fail state.

- Prefer artifacts or summaries for coverage, generated docs, CodeQL, dependency review, and report-only checks.
- Coverage is a trend signal, not a percentage gate unless a spec later says otherwise.
- Keep output concise enough for agents to inspect without truncation.
