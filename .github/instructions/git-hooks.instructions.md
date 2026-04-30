---
applyTo: ".github/workflows/*.yml,.github/workflows/*.yaml,package.json,.githooks/**"
---

# Git hooks and CI gates

Keep local hooks and CI aligned with `package.json` scripts.

- Pre-commit should run formatting/lint checks that are quick and deterministic.
- Pre-push should run the same fast gate as CI when practical.
- Do not add hook-only behavior that CI cannot reproduce.
