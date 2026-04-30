---
description: Keep git hooks and CI gates aligned with package scripts.
paths:
  - ".git/hooks/pre-commit"
  - ".git/hooks/pre-push"
  - ".github/workflows/*.yml"
  - ".github/workflows/*.yaml"
  - "package.json"
  - ".githooks/**"
---

Keep local hooks and CI aligned with `package.json` scripts.

- Pre-commit should run formatting/lint checks that are quick and deterministic.
- Pre-push should run the same fast gate as CI when practical.
- Do not add hook-only behavior that CI cannot reproduce.
