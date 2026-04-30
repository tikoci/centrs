---
paths:
  - ".git/hooks/pre-commit"
  - ".git/hooks/pre-push"
  - ".github/workflows/*.yml"
  - "package.json"
  - ".githooks/*"
---


> CONTEXT: .git/hooks runs lint/test automatically
> TODO: link .githooks as repo-level git rules to .git/hooks in an appropriate manner, which should largely do `bun run git:...`
> TODO: determine what should be one at those phases, and define in package.json
