---
paths:
  - ".github/workflows/*.yaml"
  - ".github/workflows/*.yml"
---

> TODO: basically we want the CI to collect various test to allow human review of build to spot trends or potential flags or track success (e.g. improvement from past metrics)
>
> - bun test --coverage (no fail, but like to track to compare as "trend-line" of recent builds, should **not** fail if XX% not met <-- use to spot areas for improvement => coverage # is **not** a goal, rather a guide to future work if area is testable but uncovers, with knowledge that some stuff is not easily tested)
> - `cloc` - show based on --git likely to avoid node_modules
> - linting results, especially ones where failure is okay (so there "report only)
> - skillcheck report
> - codeql data
> - should have some mechanism to track over time these metrics, or at least last diff from last build(s) in stored in GitHub be okay .
